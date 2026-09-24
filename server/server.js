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
            callback({ success: false, message: 'Player not found in room' });
        }
    });
    
    // Roll dice
    socket.on('rollDice', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.game.gameStarted) return;
        
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
    
    // Pull skill
    socket.on('usePull', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.game.gameStarted) return;
        
        const currentPlayer = room.game.getCurrentPlayer();
        if (currentPlayer.id !== socket.id) {
            socket.emit('pullError', { message: 'Not your turn' });
            return;
        }
        
        const result = room.game.pullPlayer(socket.id, data.targetId);
        
        if (result.success) {
            console.log(`[Pull] ${result.caster} pulled ${result.target} from ${result.fromPosition} to ${result.toPosition}`);
            io.to(currentRoom).emit('pullUsed', {
                message: result.message,
                state: room.game.getState()
            });
        } else {
            socket.emit('pullError', { message: result.error || 'Pull failed' });
        }
    });
    
    // Shield battle - this is for when a player is close to winning
    // and another player's dice would land on them
    socket.on('shieldBattleStart', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // Start shield battle between attacker and defender
        room.game.shieldBattle = {
            attacker: data.attackerId,
            defender: data.defenderId,
            attackerPresses: 0,
            defenderPresses: 0,
            startTime: Date.now(),
            duration: 3000 // 3 seconds
        };
        
        io.to(currentRoom).emit('shieldBattleStarted', {
            attacker: data.attackerId,
            defender: data.defenderId,
            duration: 3000
        });
    });
    
    // Shield battle - spacebar press
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
    
    // Shield battle - end (called by client after timer)
    socket.on('shieldBattleEnd', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.game.shieldBattle) return;
        
        const battle = room.game.shieldBattle;
        const attackerWins = battle.attackerPresses > battle.defenderPresses;
        
        const attacker = room.game.getPlayerById(battle.attacker);
        const defender = room.game.getPlayerById(battle.defender);
        
        io.to(currentRoom).emit('shieldBattleEnded', {
            winner: attackerWins ? 'attacker' : 'defender',
            winnerName: attackerWins ? attacker.name : defender.name,
            attackerPresses: battle.attackerPresses,
            defenderPresses: battle.defenderPresses,
            state: room.game.getState()
        });
        
        room.game.shieldBattle = null;
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
                    
                    if (reconnected) {
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
