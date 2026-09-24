const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const Game = require('./game');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Store active games/rooms
const rooms = new Map();

// Generate random room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Advance turn AFTER the client confirms its animation finished (with a safety fallback)
function scheduleNextTurn(roomCode, expectedAnimMs) {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.nextTurnTimer) clearTimeout(room.nextTurnTimer);

    const doNextTurn = () => {
        if (room.nextTurnDone) return;
        room.nextTurnDone = true;
        room.game.nextTurn();
        io.to(roomCode).emit('turnChanged', room.game.getState());
        // Continue bot turns if next player is also bot
        startBotTurns(roomCode);
    };

    room.nextTurnDone = false;
    room.pendingNextTurn = doNextTurn;

    // Fallback: if client never sends animationComplete (refresh/closed tab), advance anyway
    room.nextTurnTimer = setTimeout(doNextTurn, expectedAnimMs + 3000);
}

// Estimate how long the client animation takes: 1s dice + 300ms per box (dice, snake, ladder) + effects
function estimateAnimationMs(oldPos, newPos, finalPos) {
    const diceSteps = Math.abs(newPos - oldPos);
    const specialSteps = Math.abs(finalPos - newPos);
    let ms = 1000 + (diceSteps + specialSteps) * 300;
    if (specialSteps > 0) ms += 800; // shake/bounce + pause before special move
    return ms;
}

// Simulate spacebar presses for a BOT defender in a shield battle (bots have no live socket).
function startBotShieldPresses(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.game.shieldBattle) return;
    const battle = room.game.shieldBattle;
    const tick = setInterval(() => {
        const r = rooms.get(roomCode);
        // Battle replaced/ended already - stop ticking
        if (!r || r.game.shieldBattle !== battle) {
            clearInterval(tick);
            return;
        }
        const elapsed = Date.now() - battle.startTime;
        if (elapsed >= battle.duration) {
            clearInterval(tick);
            return;
        }
        battle.defenderPresses += Math.floor(Math.random() * 3); // 0-2 presses per tick
        io.to(roomCode).emit('shieldBattleUpdate', {
            attackerPresses: battle.attackerPresses,
            defenderPresses: battle.defenderPresses,
            timeLeft: battle.duration - elapsed
        });
    }, 110);
}

// Resolve an in-progress shield battle triggered by a Pull attempt.
// Idempotent: safe to call from the client timer and the server safety-net timeout.
function resolveShieldBattle(roomCode, reason) {
    const room = rooms.get(roomCode);
    if (!room || !room.game.shieldBattle) return;

    const battle = room.game.shieldBattle;
    const pending = battle.pendingPull;
    room.game.shieldBattle = null;

    // No pending pull (shouldn't happen) - just close the modal on all clients
    if (!pending) {
        io.to(roomCode).emit('shieldBattleEnded', { state: room.game.getState() });
        return;
    }

    const attackerWins = battle.attackerPresses > battle.defenderPresses;
    const caster = room.game.getPlayerById(pending.casterId);
    const target = room.game.getPlayerById(pending.targetId);

    let message;
    if (attackerWins && caster && target) {
        target.position = pending.casterPosition;
        message = `${caster.name} broke through ${target.name}'s shield and pulled them to ${pending.casterPosition}`;
        console.log(`[ShieldBattle:${reason}] attacker wins - ${message}`);
    } else if (caster && target) {
        message = `${target.name} raised a shield and blocked ${caster.name}'s pull!`;
        console.log(`[ShieldBattle:${reason}] defender wins - ${message}`);
    } else {
        message = 'Shield battle ended';
        console.log(`[ShieldBattle:${reason}] player missing - ${message}`);
    }

    io.to(roomCode).emit('shieldBattleEnded', {
        winner: attackerWins ? 'attacker' : 'defender',
        winnerName: attackerWins
            ? (caster ? caster.name : 'Attacker')
            : (target ? target.name : 'Defender'),
        attackerPresses: battle.attackerPresses,
        defenderPresses: battle.defenderPresses,
        pullApplied: attackerWins,
        resultMessage: message,
        state: room.game.getState()
    });
}

// Bot turn handler
function startBotTurns(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.game.gameStarted) {
        console.log('[Bot] startBotTurns: room not found or game not started');
        return;
    }
    
    const currentPlayer = room.game.getCurrentPlayer();
    const playerData = room.players.get(currentPlayer.id);
    
    console.log('[Bot] startBotTurns: current player =', currentPlayer.name, ', isBot =', playerData?.isBot);
    
    // If it's a bot's turn, auto-roll after delay
    if (playerData && playerData.isBot) {
        setTimeout(() => {
            if (!room.game.gameStarted) {
                console.log('[Bot] Game no longer started, skipping bot roll');
                return;
            }
            
            // Re-check it's still this bot's turn
            const current = room.game.getCurrentPlayer();
            if (current.id !== currentPlayer.id) {
                console.log('[Bot] Turn changed, skipping', currentPlayer.name);
                return;
            }
            
            const oldPosition = currentPlayer.position;
            const diceValue = room.game.rollDice();
            const result = room.game.movePlayer(currentPlayer.id, diceValue);
            
            console.log('[Bot]', currentPlayer.name, 'rolled', diceValue, 'from', oldPosition, 'to', result.position);
            
            // Determine final position and special tiles
            let finalPosition = result.position;
            let isSnake = false;
            let isLadder = false;
            let snakeHead = null;
            let snakeTail = null;
            let ladderBottom = null;
            let ladderTop = null;
            
            if (result.snake) {
                isSnake = true;
                snakeHead = result.position;
                snakeTail = result.snakeTail;
                finalPosition = result.snakeTail;
                room.game.applySnakeSlide(currentPlayer.id, finalPosition);
            } else if (result.ladder) {
                isLadder = true;
                ladderBottom = result.position;
                ladderTop = result.finalPosition;
                finalPosition = result.finalPosition;
            }
            
            io.to(roomCode).emit('diceRolled', {
                playerId: currentPlayer.id,
                playerName: currentPlayer.name,
                diceValue: diceValue,
                oldPosition: oldPosition,
                newPosition: result.position,
                finalPosition: finalPosition,
                result: result,
                snake: isSnake,
                snakeHead: snakeHead,
                snakeTail: snakeTail,
                ladder: isLadder,
                ladderBottom: ladderBottom,
                ladderTop: ladderTop
            });
            
            // Check for winner
            if (result.winner) {
                io.to(roomCode).emit('gameOver', {
                    winner: result.winner.name,
                    state: room.game.getState()
                });
                return;
            }
            
            // Wait for client animation to complete before next turn
            scheduleNextTurn(roomCode, estimateAnimationMs(oldPosition, result.position, finalPosition));
        }, 1500);
    }
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    let currentRoom = null;
    let playerName = null;
    let isHost = false;
    
    // Create room
    socket.on('createRoom', (data, callback) => {
        const roomCode = generateRoomCode();
        const game = new Game(roomCode, socket.id);
        
        rooms.set(roomCode, {
            game: game,
            host: socket.id,
            players: new Map()
        });
        
        currentRoom = roomCode;
        playerName = data.playerName;
        isHost = true;
        
        // Add host as spectator (not a player)
        rooms.get(roomCode).players.set(socket.id, {
            id: socket.id,
            name: data.playerName,
            avatar: data.avatar || null,
            isHost: true
        });
        
        socket.join(roomCode);
        callback({ success: true, roomCode: roomCode });
        
        console.log(`Room created: ${roomCode} by ${data.playerName}`);
    });
    
    // Join room
    socket.on('joinRoom', (data, callback) => {
        const roomCode = data.roomCode.toUpperCase();
        const room = rooms.get(roomCode);
        
        if (!room) {
            callback({ success: false, message: 'Room not found' });
            return;
        }
        
        if (room.game.gameStarted) {
            callback({ success: false, message: 'Game already started' });
            return;
        }
        
        if (room.game.players.length >= 20) {
            callback({ success: false, message: 'Room is full (max 20 players)' });
            return;
        }
        
        currentRoom = roomCode;
        playerName = data.playerName;
        isHost = false;
        
        // Add player to game
        room.game.addPlayer(socket.id, data.playerName, data.avatar);
        room.players.set(socket.id, {
            id: socket.id,
            name: data.playerName,
            avatar: data.avatar || null,
            isHost: false
        });
        
        socket.join(roomCode);
        callback({ success: true, roomCode: roomCode });
        
        // Notify everyone in room
        io.to(roomCode).emit('playerJoined', {
            playerName: data.playerName,
            playerCount: room.game.players.length,
            players: room.game.players.map(p => ({ name: p.name, id: p.id, avatar: p.avatar }))
        });
        
        console.log(`${data.playerName} joined room ${roomCode}`);
    });
    
    // Start game (host only)
    socket.on('startGame', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // Authoritative host check - survives rejoin/host transfer better than the socket-local flag
        if (room.host !== socket.id) return;
        
        // Human players only - no bot fill in normal rooms (Test Mode has its own bots)
        
        if (room.game.start()) {
            io.to(currentRoom).emit('gameStarted', room.game.getState());
            console.log(`Game started in room ${currentRoom}`);
            
            // Start bot turns
            startBotTurns(currentRoom);
        } else {
            socket.emit('error', { message: 'Need at least 2 players to start' });
        }
    });
    
    // Test mode - single player with bots
    socket.on('testMode', (data, callback) => {
        const roomCode = 'TEST';
        
        // Remove existing test room if any
        if (rooms.has(roomCode)) {
            const oldRoom = rooms.get(roomCode);
            io.to(roomCode).emit('roomClosed');
            rooms.delete(roomCode);
        }
        
        const game = new Game(roomCode, socket.id);
        
        rooms.set(roomCode, {
            game: game,
            host: socket.id,
            players: new Map(),
            isTestRoom: true
        });
        
        currentRoom = roomCode;
        playerName = data.playerName;
        isHost = true;
        
        // Add player
        game.addPlayer(socket.id, data.playerName, data.avatar);
        rooms.get(roomCode).players.set(socket.id, {
            id: socket.id,
            name: data.playerName,
            avatar: data.avatar || null,
            isHost: true
        });
        
        // Add 3 bots
        for (let i = 1; i <= 3; i++) {
            const botId = 'bot_' + i + '_' + Math.random().toString(36).substring(7);
            const botName = 'Bot ' + i;
            game.addPlayer(botId, botName);
            rooms.get(roomCode).players.set(botId, {
                id: botId,
                name: botName,
                isBot: true
            });
        }
        
        socket.join(roomCode);
        
        // Start game immediately
        game.start();
        console.log(`Test mode started by ${data.playerName}`);
        
        // Return game state in callback so client can store it before redirect
        callback({ success: true, roomCode: roomCode, gameState: game.getState() });
    });
    
    // Rejoin room after page redirect
    socket.on('rejoinRoom', (data, callback) => {
        const roomCode = data.roomCode;
        const room = rooms.get(roomCode);
        
        if (!room) {
            callback({ success: false, message: 'Room not found' });
            return;
        }
        
        // Resolve by the player's known id first (exact, safe for duplicate names),
        // fall back to name match for old sessions - never match bots
        let player = data.playerId ? room.game.getPlayerById(data.playerId) : null;
        if (!player) {
            player = room.game.players.find(p => p.name === data.playerName && !p.id.startsWith('bot_'));
        }
        
        if (player) {
            const oldId = player.id;
            
            // Only take the host slot if the previous host is truly gone
            // (their room entry is removed on cleanup, so no live socket holds it)
            const hostAlive = room.players.has(room.host);
            const willBeHost = !hostAlive || oldId === room.host;
            
            // Remove old socket ID mapping
            room.players.delete(oldId);
            
            // Update player ID to new socket ID
            player.id = socket.id;
            if (data.avatar) player.avatar = data.avatar;
            room.players.set(socket.id, {
                id: socket.id,
                name: player.name,
                avatar: player.avatar || null,
                isHost: willBeHost
            });
            
            if (willBeHost) {
                room.host = socket.id;
            }
            
            currentRoom = roomCode;
            playerName = player.name;
            isHost = willBeHost;
            
            socket.join(roomCode);
            
            console.log(`Player ${player.name} rejoined room ${roomCode} with new socket ${socket.id}${willBeHost ? ' (host)' : ''}`);
            callback({ success: true, gameState: room.game.getState() });
            
            // If it's currently a bot's turn, start bot turns
            const currentPlayer = room.game.getCurrentPlayer();
            const currentPlayerData = room.players.get(currentPlayer.id);
            if (currentPlayerData && currentPlayerData.isBot) {
                startBotTurns(roomCode);
            }
        } else {
            // Not a game player - the SPECTATOR HOST may be rejoining after the
            // lobby -> game.html redirect. The host is never in game.players, so
            // match them against the stored host entry in the connection map.
            let hostEntry = null;
            for (const [id, info] of room.players.entries()) {
                if (info.isHost && info.name === data.playerName) {
                    hostEntry = { id, info };
                    break;
                }
            }

            if (hostEntry) {
                room.players.delete(hostEntry.id);
                room.players.set(socket.id, {
                    id: socket.id,
                    name: hostEntry.info.name,
                    avatar: data.avatar || hostEntry.info.avatar || null,
                    isHost: true
                });
                room.host = socket.id;

                currentRoom = roomCode;
                playerName = hostEntry.info.name;
                isHost = true;

                socket.join(roomCode);

                console.log(`Spectator host ${hostEntry.info.name} rejoined room ${roomCode} with new socket ${socket.id}`);
                callback({ success: true, gameState: room.game.getState() });

                // Resume bot turns if it's currently a bot's turn
                const currentPlayer = room.game.getCurrentPlayer();
                const currentPlayerData = room.players.get(currentPlayer.id);
                if (currentPlayerData && currentPlayerData.isBot) {
                    startBotTurns(roomCode);
                }
            } else {
                callback({ success: false, message: 'Player not found in room' });
            }
        }
    });
    
    // Roll dice
    socket.on('rollDice', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.game.gameStarted) return;
        
        // Block rolling while a pull shield battle is resolving
        if (room.game.shieldBattle) return;
        
        const currentPlayer = room.game.getCurrentPlayer();
        if (currentPlayer.id !== socket.id) {
            console.log('Not your turn:', socket.id, 'vs', currentPlayer.id);
            return; // Not your turn
        }
        
        const oldPosition = currentPlayer.position;
        const diceValue = room.game.rollDice();
        const result = room.game.movePlayer(socket.id, diceValue);
        
        console.log('Dice rolled:', { player: currentPlayer.name, dice: diceValue, result });
        
        // Check if landed on snake
        if (result.snake) {
            // Don't apply snake slide yet - let client animate it
            // But we need to store the final position
            const finalPosition = result.snakeTail;
            
            io.to(currentRoom).emit('diceRolled', {
                playerId: socket.id,
                playerName: currentPlayer.name,
                diceValue: diceValue,
                oldPosition: oldPosition,
                newPosition: result.position, // Position after dice (snake head)
                finalPosition: finalPosition, // Position after snake slide
                result: {
                    ...result,
                    // Don't apply slide yet
                },
                snake: true,
                snakeHead: result.position,
                snakeTail: finalPosition
            });
            
            // Apply snake slide after sending event
            room.game.applySnakeSlide(socket.id, finalPosition);
            
            // Check for winner
            if (result.winner) {
                io.to(currentRoom).emit('gameOver', {
                    winner: result.winner.name,
                    state: room.game.getState()
                });
                return;
            }
            
            // Wait for client animation to complete before next turn
            scheduleNextTurn(currentRoom, estimateAnimationMs(oldPosition, result.position, finalPosition));
        } else if (result.ladder) {
            // Ladder climb
            io.to(currentRoom).emit('diceRolled', {
                playerId: socket.id,
                playerName: currentPlayer.name,
                diceValue: diceValue,
                oldPosition: oldPosition,
                newPosition: result.position, // Position after dice (ladder bottom)
                finalPosition: result.finalPosition, // Position after ladder climb
                result: result,
                ladder: true,
                ladderBottom: result.position,
                ladderTop: result.finalPosition
            });
            
            // Check for winner
            if (result.winner) {
                io.to(currentRoom).emit('gameOver', {
                    winner: result.winner.name,
                    state: room.game.getState()
                });
                return;
            }
            
            // Wait for client animation to complete before next turn
            scheduleNextTurn(currentRoom, estimateAnimationMs(oldPosition, result.position, result.finalPosition));
        } else {
            // Normal move
            io.to(currentRoom).emit('diceRolled', {
                playerId: socket.id,
                playerName: currentPlayer.name,
                diceValue: diceValue,
                oldPosition: oldPosition,
                newPosition: result.position,
                finalPosition: result.position,
                result: result
            });
            
            // Check for winner
            if (result.winner) {
                io.to(currentRoom).emit('gameOver', {
                    winner: result.winner.name,
                    state: room.game.getState()
                });
                return;
            }
            
            // Wait for client animation to complete before next turn
            scheduleNextTurn(currentRoom, estimateAnimationMs(oldPosition, result.position, result.position));
        }
    });
    
    // Pull skill - triggers a shield battle with the target before the pull lands
    socket.on('usePull', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.game.gameStarted) return;
        
        const currentPlayer = room.game.getCurrentPlayer();
        if (currentPlayer.id !== socket.id) {
            socket.emit('pullError', { message: 'Not your turn' });
            return;
        }
        
        if (room.game.shieldBattle) {
            socket.emit('pullError', { message: 'A shield battle is already in progress' });
            return;
        }
        
        // Validate the pull attempt WITHOUT moving anyone yet
        const caster = room.game.getPlayerById(socket.id);
        const target = room.game.getPlayerById(data.targetId);
        if (!caster || !target) {
            socket.emit('pullError', { message: 'Player not found' });
            return;
        }
        if (caster.pullUsed) {
            socket.emit('pullError', { message: 'Pull skill already used' });
            return;
        }
        if (caster.id === target.id) {
            socket.emit('pullError', { message: 'Cannot pull yourself' });
            return;
        }
        
        // Consume the Pull skill now - it is one-shot whether the battle is won or lost
        caster.pullUsed = true;
        
        // Start the shield battle: attacker = caster, defender = target
        room.game.shieldBattle = {
            attacker: caster.id,
            defender: target.id,
            attackerPresses: 0,
            defenderPresses: 0,
            startTime: Date.now(),
            duration: 3000,
            pendingPull: { casterId: caster.id, targetId: target.id, casterPosition: caster.position }
        };
        
        console.log(`[Pull] ${caster.name} attempts to pull ${target.name} -> shield battle started`);
        
        io.to(currentRoom).emit('shieldBattleStarted', {
            attacker: caster.id,
            defender: target.id,
            duration: 3000
        });
        
        // A bot defender has no live socket, so simulate its presses server-side
        const targetConn = room.players.get(target.id);
        if (targetConn && targetConn.isBot) {
            startBotShieldPresses(currentRoom);
        }
        
        // Safety net: if the client-driven end never arrives (refresh/closed tab),
        // resolve anyway so the game can't hang on an open battle.
        const pendingCasterId = caster.id;
        setTimeout(() => {
            const r = rooms.get(currentRoom);
            if (r && r.game.shieldBattle && r.game.shieldBattle.pendingPull &&
                r.game.shieldBattle.pendingPull.casterId === pendingCasterId) {
                resolveShieldBattle(currentRoom, 'timeout');
            }
        }, 3000 + 2500);
    });
    
    // Shield battle - spacebar press (attacker = puller, defender = pull target).
    // A battle is started automatically by usePull; there is no manual start event.
    socket.on('shieldBattlePress', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.game.shieldBattle) return;
        
        const battle = room.game.shieldBattle;
        const elapsed = Date.now() - battle.startTime;
        
        if (elapsed > battle.duration) return; // Battle ended
        
        if (socket.id === battle.attacker) {
            battle.attackerPresses++;
        } else if (socket.id === battle.defender) {
            battle.defenderPresses++;
        }
        
        // Update battle progress
        io.to(currentRoom).emit('shieldBattleUpdate', {
            attackerPresses: battle.attackerPresses,
            defenderPresses: battle.defenderPresses,
            timeLeft: battle.duration - elapsed
        });
    });
    
    // Shield battle - end (called by the client when its timer runs out)
    socket.on('shieldBattleEnd', () => {
        if (!currentRoom) return;
        resolveShieldBattle(currentRoom, 'client');
    });
    
    // Client finished its dice/movement animation - advance the turn now
    socket.on('animationComplete', () => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || !room.game.gameStarted) return;
        if (room.pendingNextTurn) {
            console.log('[Turn] animationComplete received, advancing turn');
            room.pendingNextTurn();
        }
    });
    
    // Request current game state
    socket.on('requestState', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (room) {
            socket.emit('gameState', room.game.getState());
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        if (currentRoom && playerName) {
            const room = rooms.get(currentRoom);
            if (room) {
                // Check if this is a page redirect (test mode or normal game flow)
                // Wait 5 seconds for the player to rejoin before cleaning up
                const savedRoom = currentRoom;
                const savedPlayerName = playerName;
                const savedIsHost = isHost;
                const savedSocketId = socket.id;
                
                setTimeout(() => {
                    const room = rooms.get(savedRoom);
                    if (!room) return; // Room already cleaned up
                    
                    // Check if player reconnected - rejoinRoom keeps the same player
                    // object but swaps its id to the new socket
                    const player = room.game.players.find(p => p.name === savedPlayerName && p.id !== savedSocketId);
                    const reconnected = player && room.players.has(player.id);
                    
                    // Spectator host reconnected: rejoinRoom migrated room.host to a
                    // new live socket, so the old host socket must not trigger cleanup
                    const reconnectedHost = savedIsHost && room.host !== savedSocketId && room.players.has(room.host);
                    
                    if (reconnected || reconnectedHost) {
                        console.log(`Player ${savedPlayerName} reconnected, skipping cleanup`);
                        return;
                    }
                    
                    // Player didn't reconnect - clean up
                    console.log(`Player ${savedPlayerName} did not reconnect, cleaning up`);
                    
                    // Remove player from game (also fixes currentTurn index)
                    room.game.removePlayer(savedSocketId);
                    room.players.delete(savedSocketId);
                    
                    // If the disconnected socket was the room host, free the host slot
                    // (transfer to an alive player if any, so someone can still start the game)
                    if (room.host === savedSocketId) {
                        room.players.delete(savedSocketId);
                        const alive = room.game.players.find(p => room.players.has(p.id) && !p.id.startsWith('bot_'));
                        if (alive) {
                            room.host = alive.id;
                            const entry = room.players.get(alive.id);
                            if (entry) entry.isHost = true;
                            console.log(`Host slot transferred to ${alive.name}`);
                        }
                        if (!room.game.gameStarted && room.game.players.length === 0) {
                            io.to(savedRoom).emit('roomClosed');
                            rooms.delete(savedRoom);
                            return;
                        }
                    }
                    
                    // Notify lobby waiters so the player list stays accurate
                    if (!room.game.gameStarted) {
                        io.to(savedRoom).emit('playerLeft', {
                            playerName: savedPlayerName,
                            players: room.game.players.map(p => ({ name: p.name, id: p.id, avatar: p.avatar }))
                        });
                    }
                    
                    // If host left and it's a test room, clean up
                    if (savedIsHost && room.isTestRoom) {
                        rooms.delete(savedRoom);
                        console.log(`Test room ${savedRoom} cleaned up`);
                    }
                }, 5000); // 5 second grace period
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
