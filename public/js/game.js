// Game Client Script
const socket = io();

// Get stored session data
const gameState = JSON.parse(sessionStorage.getItem('gameState') || '{}');
const roomCode = sessionStorage.getItem('roomCode');
const playerName = sessionStorage.getItem('playerName');
const isHost = sessionStorage.getItem('isHost') === 'true';
const myStoredPlayerId = sessionStorage.getItem('playerId'); // stable id from a previous session, for rejoin
const myAvatar = sessionStorage.getItem('avatar'); // my profile picture dataURL

// Check if we have valid session
if (!roomCode || !playerName) {
    window.location.href = '/';
}

// DOM Elements
const gameBoard = document.getElementById('gameBoard');
const gameRoomCode = document.getElementById('gameRoomCode');
const currentPlayerName = document.getElementById('currentPlayerName');
const gamePlayersList = document.getElementById('gamePlayersList');
const diceDisplay = document.getElementById('diceDisplay');
const rollDiceBtn = document.getElementById('rollDiceBtn');
const diceResult = document.getElementById('diceResult');
const pullSkillBtn = document.getElementById('pullSkillBtn');
const pullTargetSelect = document.getElementById('pullTargetSelect');
const pullTargetList = document.getElementById('pullTargetList');
const cancelPullBtn = document.getElementById('cancelPullBtn');
const gameLog = document.getElementById('gameLog');
const shieldBattleModal = document.getElementById('shieldBattleModal');
const attackerName = document.getElementById('attackerName');
const defenderName = document.getElementById('defenderName');
const attackerPresses = document.getElementById('attackerPresses');
const defenderPresses = document.getElementById('defenderPresses');
const attackerBar = document.getElementById('attackerBar');
const defenderBar = document.getElementById('defenderBar');
const timerFill = document.getElementById('timerFill');
const gameOverModal = document.getElementById('gameOverModal');
const winnerName = document.getElementById('winnerName');
const playAgainBtn = document.getElementById('playAgainBtn');

// Game state
let currentState = gameState;
let myPlayerId = null;
let shieldBattleActive = false;
let myPresses = 0;
let battleStartTime = 0;
let battleTimer = null;
let isAnimating = false; // Track if movement animation is in progress

// Player colors - one distinct color per seat, supports up to 20 players
const playerColors = [
    '#e91e63', '#2196f3', '#4caf50', '#ff9800',
    '#9c27b0', '#00bcd4', '#ff5722', '#3f51b5',
    '#8bc34a', '#f44336', '#009688', '#ffc107',
    '#673ab7', '#795548', '#607d8b', '#e040fb',
    '#76ff03', '#ff6e40', '#40c4ff', '#ffd740'
];

// ============ SOUND ENGINE (Web Audio API - no audio files needed) ============
const SoundFX = (() => {
    let ctx = null;
    let enabled = true;

    function ensure() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function tone(freq, dur, type = 'sine', vol = 0.15, when = 0, slideTo = null) {
        if (!enabled) return;
        try {
            const ac = ensure();
            const t0 = ac.currentTime + when;
            const o = ac.createOscillator();
            const g = ac.createGain();
            o.type = type;
            o.frequency.setValueAtTime(freq, t0);
            if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            o.connect(g); g.connect(ac.destination);
            o.start(t0);
            o.stop(t0 + dur + 0.05);
        } catch (e) { /* audio not available */ }
    }

    function noise(dur, vol = 0.1, when = 0) {
        if (!enabled) return;
        try {
            const ac = ensure();
            const t0 = ac.currentTime + when;
            const n = Math.floor(ac.sampleRate * dur);
            const buf = ac.createBuffer(1, n, ac.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
            const src = ac.createBufferSource();
            src.buffer = buf;
            const g = ac.createGain();
            g.gain.value = vol;
            src.connect(g); g.connect(ac.destination);
            src.start(t0);
        } catch (e) { /* audio not available */ }
    }

    return {
        setEnabled(v) { enabled = v; },
        isEnabled() { return enabled; },
        unlock() { try { ensure(); } catch (e) {} },
        diceRoll() {
            for (let i = 0; i < 8; i++) noise(0.05, 0.08, i * 0.1);
        },
        diceResult(value) {
            if (value < 0) {
                tone(300, 0.35, 'sawtooth', 0.15, 0, 100);
            } else {
                tone(523, 0.1, 'triangle', 0.2);
                tone(784, 0.18, 'triangle', 0.2, 0.1);
            }
        },
        step() { tone(650 + Math.random() * 150, 0.06, 'square', 0.05); },
        snake() {
            noise(0.5, 0.12);
            tone(420, 0.55, 'sawtooth', 0.12, 0, 70);
        },
        ladder() {
            for (let i = 0; i < 6; i++) tone(400 + i * 110, 0.08, 'square', 0.09, i * 0.07);
        },
        pull() {
            tone(900, 0.28, 'sine', 0.18, 0, 180);
            noise(0.15, 0.06);
        },
        rankUp() { tone(500, 0.09, 'triangle', 0.12); tone(750, 0.14, 'triangle', 0.12, 0.09); },
        rankDown() { tone(400, 0.09, 'triangle', 0.12); tone(260, 0.14, 'triangle', 0.12, 0.09); },
        battleStart() {
            tone(440, 0.12, 'square', 0.15);
            tone(587, 0.12, 'square', 0.15, 0.13);
            tone(880, 0.22, 'square', 0.15, 0.26);
        },
        press() { tone(1100, 0.03, 'square', 0.05); },
        win() {
            const notes = [523, 659, 784, 1047, 784, 1047];
            notes.forEach((f, i) => tone(f, 0.22, 'triangle', 0.2, i * 0.15));
        },
        lose() {
            tone(392, 0.3, 'sawtooth', 0.12);
            tone(311, 0.3, 'sawtooth', 0.12, 0.28);
            tone(233, 0.6, 'sawtooth', 0.12, 0.56);
        }
    };
})();

// ============ BACKGROUND MUSIC (hidden, looped YouTube player) ============
const MusicEngine = (() => {
    const VIDEO_ID = '4X8P5K9pVMc';
    const VOLUME = 22; // keep it low so it doesn't overpower SFX
    let player = null;
    let ready = false;
    let enabled = true;
    let wantsPlay = false; // play ASAP once ready + unlocked

    function create() {
        if (typeof YT === 'undefined' || !YT.Player) return;
        player = new YT.Player('bgMusicPlayer', {
            videoId: VIDEO_ID,
            playerVars: {
                autoplay: 0,
                controls: 0,
                disablekb: 1,
                loop: 1,
                playlist: VIDEO_ID,
                modestbranding: 1,
                playsinline: 1,
                rel: 0
            },
            events: {
                onReady: () => {
                    ready = true;
                    try { player.setVolume(VOLUME); } catch (e) {}
                    if (wantsPlay && enabled) tryPlay();
                },
                onStateChange: (e) => {
                    // Loop fallback in case the embedded loop doesn't kick in
                    if (e.data === YT.PlayerState.ENDED) {
                        try { player.seekTo(0); player.playVideo(); } catch (err) {}
                    }
                },
                onError: (e) => {
                    console.warn('Background music failed to load:', e.data);
                    if (typeof addLogEntry === 'function') {
                        addLogEntry('Background music unavailable (video can\'t be embedded). Sounds still work.', 'error');
                    }
                }
            }
        });
    }

    function tryPlay() {
        if (!ready || !player) return;
        try { player.playVideo(); } catch (e) {}
    }

    return {
        init() {
            if (typeof YT !== 'undefined' && YT.Player) {
                create();
            } else {
                window.onYouTubeIframeAPIReady = create;
            }
        },
        // Called on first user gesture (browser autoplay policy)
        unlock() {
            wantsPlay = enabled;
            if (ready && enabled) tryPlay();
        },
        setEnabled(v) {
            enabled = v;
            if (!ready || !player) { wantsPlay = v; return; }
            try {
                if (v) player.playVideo();
                else player.pauseVideo();
            } catch (e) {}
        },
        isEnabled() { return enabled; }
    };
})();

// Board configuration - 9 snakes
const snakes = {
    16: 6,
    47: 25,
    49: 11,
    56: 37,
    62: 19,
    75: 45,
    87: 24,
    88: 33,
    99: 50
};

// 9 ladders
const ladders = {
    2: 20,
    4: 25,
    8: 30,
    15: 40,
    28: 84,
    35: 42,
    41: 62,
    55: 75,
    68: 85
};

// Initialize game
function initGame() {
    gameRoomCode.textContent = roomCode;
    renderBoard();
    MusicEngine.init();
    
    // Find my player ID from game state
    if (currentState.players) {
        const myPlayer = currentState.players.find(p => p.id === myStoredPlayerId) ||
            currentState.players.find(p => p.name === playerName);
        if (myPlayer) {
            myPlayerId = myPlayer.id;
            sessionStorage.setItem('playerId', myPlayer.id);
        }
    }
    
    updateGameState(currentState);
    setupEventListeners();
}

// Render the game board
function renderBoard() {
    gameBoard.innerHTML = '';
    
    // Create 100 cells (10x10 grid)
    // Board is numbered from bottom-left, going in snake pattern
    for (let row = 9; row >= 0; row--) {
        for (let col = 0; col < 10; col++) {
            let cellNumber;
            // Snake pattern: even rows go left-to-right, odd rows go right-to-left
            if ((9 - row) % 2 === 0) {
                cellNumber = row * 10 + col + 1;
            } else {
                cellNumber = row * 10 + (9 - col) + 1;
            }
            
            const cell = document.createElement('div');
            cell.className = 'board-cell';
            cell.dataset.cellNumber = cellNumber;
            
            // Add cell number
            const numberSpan = document.createElement('span');
            numberSpan.className = 'cell-number';
            numberSpan.textContent = cellNumber;
            cell.appendChild(numberSpan);
            
            // Check for snake head
            if (snakes[cellNumber]) {
                cell.classList.add('snake-head');
                const icon = document.createElement('span');
                icon.className = 'snake-icon';
                icon.textContent = '🐍';
                cell.appendChild(icon);
                
                // Show destination clearly
                const dest = document.createElement('span');
                dest.className = 'destination snake-dest';
                dest.textContent = `→${snakes[cellNumber]}`;
                cell.appendChild(dest);
            }
            
            // Check for ladder bottom
            if (ladders[cellNumber]) {
                cell.classList.add('ladder-bottom');
                const icon = document.createElement('span');
                icon.className = 'ladder-icon';
                icon.textContent = '🪜';
                cell.appendChild(icon);
                
                // Show destination clearly
                const dest = document.createElement('span');
                dest.className = 'destination ladder-dest';
                dest.textContent = `→${ladders[cellNumber]}`;
                cell.appendChild(dest);
            }
            
            gameBoard.appendChild(cell);
        }
    }
}

// Update game state
function updateGameState(state) {
    currentState = state;
    
    // Update current player
    if (state.currentPlayer) {
        const playerIndex = state.players.findIndex(p => p.id === state.currentPlayer.id);
        const color = playerColors[playerIndex] || '#667eea';
        currentPlayerName.textContent = state.currentPlayer.name;
        currentPlayerName.style.color = color;
    }
    
    // Update players list
    updatePlayersList(state);
    
    // Update player tokens on board
    updatePlayerTokens(state);
    
    // Enable/disable roll button based on turn
    const isMyTurn = state.currentPlayer && state.currentPlayer.id === myPlayerId;
    rollDiceBtn.disabled = !isMyTurn;
    
    // Update pull skill button
    const myPlayer = state.players.find(p => p.id === myPlayerId);
    if (myPlayer) {
        pullSkillBtn.disabled = !isMyTurn || myPlayer.pullUsed;
        const statusSpan = pullSkillBtn.querySelector('.skill-status');
        statusSpan.textContent = myPlayer.pullUsed ? '(Used)' : '(Available)';
    }
    
    // Spectator (host) view
    applySpectatorMode();
}

// The room host is a spectator, not a player - hide the player-only controls
// and show a badge so it's clear they are watching, not waiting on a turn.
function applySpectatorMode() {
    const isSpectator = !myPlayerId;
    const skillsSection = document.querySelector('.skills-section');
    
    if (rollDiceBtn) rollDiceBtn.style.display = isSpectator ? 'none' : '';
    if (skillsSection) skillsSection.style.display = isSpectator ? 'none' : '';
    
    let badge = document.getElementById('spectatorBadge');
    if (isSpectator) {
        if (!badge) {
            badge = document.createElement('span');
            badge.id = 'spectatorBadge';
            badge.className = 'spectator-badge';
            badge.textContent = '👁️ Spectating';
            const header = document.querySelector('.room-info-header');
            if (header) header.insertBefore(badge, header.firstChild);
        }
        if (diceResult) diceResult.textContent = 'You are the host — spectating the game';
    } else if (badge) {
        badge.remove();
    }
}

// Update players list in side panel - sorted by position (highest first) with rank badges
let lastRanks = {}; // player name -> previous rank, for rank-change sounds

// Detect rank changes (called only on turnChanged, so sounds fire once per shift)
function detectRankChanges(state) {
    const sorted = [...state.players].sort((a, b) => b.position - a.position);
    sorted.forEach((p, i) => {
        const newRank = i + 1;
        if (lastRanks[p.name] !== undefined && lastRanks[p.name] !== newRank) {
            if (newRank < lastRanks[p.name]) SoundFX.rankUp();
            else SoundFX.rankDown();
        }
        lastRanks[p.name] = newRank;
    });
}

function updatePlayersList(state) {
    gamePlayersList.innerHTML = '';
    
    // Sort by position descending, but keep each player's original color/index
    const ranked = state.players
        .map((p, index) => ({ ...p, originalIndex: index }))
        .sort((a, b) => b.position - a.position);
    
    ranked.forEach((player, i) => {
        const rank = i + 1;
        const color = playerColors[player.originalIndex];
        
        const li = document.createElement('li');
        li.className = 'player-item';
        li.style.borderLeft = `4px solid ${color}`;
        
        if (state.currentPlayer && state.currentPlayer.id === player.id) {
            li.classList.add('current-turn');
        }
        
        // Rank badge (1st, 2nd, ...)
        const rankBadge = document.createElement('div');
        rankBadge.className = 'rank-badge' + (rank === 1 ? ' rank-leader' : '');
        rankBadge.textContent = rank === 1 ? '👑' : rank;
        rankBadge.title = rank === 1 ? 'Leader' : `Rank ${rank}`;
        
        // Player profile container
        const profileContainer = document.createElement('div');
        profileContainer.className = 'player-profile';
        
        // Player avatar: profile picture with the seat color as border,
        // or a color-filled initial when no picture was set
        const avatar = document.createElement('div');
        avatar.className = 'player-avatar';
        avatar.style.borderColor = color;
        if (player.avatar) {
            avatar.classList.add('has-image');
            avatar.style.backgroundImage = `url(${player.avatar})`;
        } else {
            avatar.style.backgroundColor = color;
            avatar.textContent = player.name.charAt(0).toUpperCase();
        }
        
        // Player info
        const infoContainer = document.createElement('div');
        infoContainer.className = 'player-info';
        
        const nameSpan = document.createElement('div');
        nameSpan.className = 'player-name';
        nameSpan.textContent = player.name;
        if (player.id === myPlayerId) {
            nameSpan.textContent += ' (You)';
        }
        
        const positionSpan = document.createElement('div');
        positionSpan.className = 'player-position';
        positionSpan.textContent = `Position: ${player.position}`;
        
        infoContainer.appendChild(nameSpan);
        infoContainer.appendChild(positionSpan);
        
        profileContainer.appendChild(avatar);
        profileContainer.appendChild(infoContainer);
        
        // Skills status
        const skillsSpan = document.createElement('span');
        skillsSpan.className = 'skills';
        skillsSpan.textContent = player.pullUsed ? '🎯' : '🎯✓';
        skillsSpan.title = player.pullUsed ? 'Pull used' : 'Pull available';
        
        li.appendChild(rankBadge);
        li.appendChild(profileContainer);
        li.appendChild(skillsSpan);
        gamePlayersList.appendChild(li);
    });
}

// Give a token (board or start area) its seat color, and the profile picture
// when the player set one - the color then shows as the circle's border
function styleToken(token, player, color) {
    if (player.avatar) {
        token.classList.add('token-avatar');
        token.style.backgroundImage = `url(${player.avatar})`;
        token.style.borderColor = color;
    } else {
        token.style.backgroundColor = color;
    }
}

// Place a token inside its cell using a compact 3-per-row grid, so many
// stacked players (up to 20) stay inside the cell instead of overflowing
function positionTokenInCell(token, stackIndex, stackCount) {
    const size = stackCount > 4 ? 14 : 22; // shrink when crowded
    token.style.width = size + 'px';
    token.style.height = size + 'px';
    
    const cols = Math.min(3, Math.max(1, stackCount));
    const row = Math.floor(stackIndex / 3);
    const col = stackIndex % 3;
    // Center the grid block within the 50px cell
    const gridW = cols * (size + 1);
    const rows = Math.ceil(stackCount / 3);
    const gridH = rows * (size + 1);
    const x = (50 - gridW) / 2 + col * (size + 1) + 1;
    const y = (50 - gridH) / 2 + row * (size + 1) + 1;
    token.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
}

// Update player tokens on board
function updatePlayerTokens(state) {
    // Remove existing tokens from board and start area
    document.querySelectorAll('.player-token').forEach(token => token.remove());
    
    const startTokensContainer = document.getElementById('startTokens');
    
    // Pre-compute how many players share each cell, and each player's slot in it
    const cellCounts = {};
    state.players.forEach(p => {
        if (p.position > 0) cellCounts[p.position] = (cellCounts[p.position] || 0) + 1;
    });
    const cellUsed = {};
    
    // Add tokens for each player
    state.players.forEach((player, index) => {
        if (player.position > 0) {
            // Player is on the board
            const cell = document.querySelector(`[data-cell-number="${player.position}"]`);
            if (cell) {
                const token = document.createElement('div');
                token.className = 'player-token';
                token.dataset.playerIndex = index;
                token.title = player.name;
                styleToken(token, player, playerColors[index] || '#667eea');
                
                const stackIndex = cellUsed[player.position] || 0;
                cellUsed[player.position] = stackIndex + 1;
                positionTokenInCell(token, stackIndex, cellCounts[player.position]);
                
                cell.appendChild(token);
            }
        } else {
            // Player is at start - show in start area
            const token = document.createElement('div');
            token.className = 'player-token';
            token.dataset.playerIndex = index;
            token.title = player.name + ' (Waiting to start)';
            styleToken(token, player, playerColors[index] || '#667eea');
            
            startTokensContainer.appendChild(token);
        }
    });
}

// Setup event listeners
function setupEventListeners() {
    // Unlock audio on first interaction (browser policy)
    document.addEventListener('click', () => { SoundFX.unlock(); MusicEngine.unlock(); }, { once: true });
    document.addEventListener('keydown', () => { SoundFX.unlock(); MusicEngine.unlock(); }, { once: true });
    
    // Sound toggle button (controls SFX + background music)
    const soundToggleBtn = document.getElementById('soundToggleBtn');
    if (soundToggleBtn) {
        soundToggleBtn.addEventListener('click', () => {
            const enabled = !SoundFX.isEnabled();
            SoundFX.setEnabled(enabled);
            MusicEngine.setEnabled(enabled);
            soundToggleBtn.textContent = enabled ? '🔊' : '🔇';
        });
    }
    
    // Roll dice
    rollDiceBtn.addEventListener('click', () => {
        SoundFX.diceRoll();
        socket.emit('rollDice');
        rollDiceBtn.disabled = true;
    });
    
    // Pull skill
    pullSkillBtn.addEventListener('click', () => {
        showPullTargetSelect();
    });
    
    // Cancel pull
    cancelPullBtn.addEventListener('click', () => {
        pullTargetSelect.classList.add('hidden');
    });
    
    // Shield battle - spacebar press
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && shieldBattleActive) {
            e.preventDefault();
            myPresses++;
            SoundFX.press();
            socket.emit('shieldBattlePress');
        }
    });
    
    // Play again
    playAgainBtn.addEventListener('click', () => {
        window.location.reload();
    });
}

// Show pull target selection
function showPullTargetSelect() {
    pullTargetList.innerHTML = '';
    
    const me = currentState.players.find(p => p.id === myPlayerId);
    const myPosText = me && me.position > 0 ? me.position : 'START (0)';
    
    currentState.players.forEach(player => {
        if (player.id !== myPlayerId) {
            const li = document.createElement('li');
            const targetPosText = player.position > 0 ? player.position : 'START (0)';
            li.textContent = `${player.name} (at ${targetPosText}) -> will be pulled to your position: ${myPosText}`;
            li.addEventListener('click', () => {
                socket.emit('usePull', { targetId: player.id });
                pullTargetSelect.classList.add('hidden');
            });
            pullTargetList.appendChild(li);
        }
    });
    
    pullTargetSelect.classList.remove('hidden');
}

// Add log entry
function addLogEntry(message, type = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = message;
    gameLog.insertBefore(entry, gameLog.firstChild);
    
    // Keep only last 20 entries
    while (gameLog.children.length > 20) {
        gameLog.removeChild(gameLog.lastChild);
    }
}

// Animate dice roll with spinning effect
function animateDice(value) {
    let spins = 0;
    const maxSpins = 10;
    const spinInterval = setInterval(() => {
        const randomValue = [-2, -1, 1, 2, 3, 4, 5, 6][Math.floor(Math.random() * 8)];
        diceDisplay.textContent = randomValue;
        spins++;
        
        if (spins >= maxSpins) {
            clearInterval(spinInterval);
            diceDisplay.textContent = value;
            diceDisplay.classList.toggle('negative', value < 0);
            
            // Add bounce effect
            diceDisplay.style.transform = 'scale(1.2)';
            SoundFX.diceResult(value);
            setTimeout(() => {
                diceDisplay.style.transform = 'scale(1)';
            }, 200);
        }
    }, 80);
}

// Socket event listeners
socket.on('diceRolled', (data) => {
    console.log('Dice rolled event received:', data);
    
    animateDice(data.diceValue);
    diceResult.textContent = `${data.playerName} rolled ${data.diceValue}`;
    
    let logMessage = `${data.playerName} rolled ${data.diceValue}`;
    let logType = '';
    
    if (data.snake) {
        logMessage += ` - Snake at ${data.snakeHead}! Slid down to ${data.snakeTail}`;
        logType = 'snake';
    } else if (data.ladder) {
        logMessage += ` - Ladder at ${data.ladderBottom}! Climbed to ${data.ladderTop}`;
        logType = 'ladder';
    }
    
    addLogEntry(logMessage, logType);
    
    // Find the player
    const playerIndex = currentState.players.findIndex(p => p.id === data.playerId);
    if (playerIndex === -1) {
        console.error('Player not found:', data.playerId);
        return;
    }
    
    const oldPos = data.oldPosition;
    const newPos = data.newPosition;
    const finalPos = data.finalPosition;
    
    console.log('Animating player', playerIndex, '(' + currentState.players[playerIndex].name + ')', 'from', oldPos, 'to', newPos, 'final', finalPos);
    
    // Immediately update the player position in state so tokens render correctly
    currentState.players[playerIndex].position = finalPos;
    
    // Animate movement for ALL players (human and bots)
    isAnimating = true;
    
    // Wait for dice animation to finish before moving player visually
    const diceAnimDuration = 1000;
    
    setTimeout(() => {
        // Animate box-by-box movement
        animatePlayerMovement(playerIndex, oldPos, newPos, () => {
            // After movement, check for snake/ladder animation
            if (data.snake) {
                setTimeout(() => {
                    animateSnakeSlide(playerIndex, newPos, data.snakeTail, () => {
                        finishAnimation();
                    });
                }, 300);
            } else if (data.ladder) {
                setTimeout(() => {
                    animateLadderClimb(playerIndex, newPos, data.ladderTop, () => {
                        finishAnimation();
                    });
                }, 300);
            } else {
                finishAnimation();
            }
        });
    }, diceAnimDuration);
});

// Animation finished - tell the server it's safe to advance the turn
function finishAnimation() {
    isAnimating = false;
    updatePlayerTokens(currentState);
    socket.emit('animationComplete');
}

// Animate player movement box by box
function animatePlayerMovement(playerIndex, fromPos, toPos, callback) {
    const steps = toPos - fromPos;
    const direction = steps > 0 ? 1 : -1;
    const absSteps = Math.abs(steps);
    let currentStep = 0;
    
    const moveInterval = setInterval(() => {
        currentStep++;
        const currentPos = fromPos + (currentStep * direction);
        
        // Update token position
        updateSinglePlayerToken(playerIndex, currentPos);
        SoundFX.step();
        
        if (currentStep >= absSteps) {
            clearInterval(moveInterval);
            // Pulse/glow the landing cell
            const landCell = document.querySelector(`[data-cell-number="${toPos}"]`);
            if (landCell) {
                landCell.classList.add('cell-landed');
                setTimeout(() => landCell.classList.remove('cell-landed'), 600);
            }
            if (callback) callback();
        }
    }, 300); // 300ms per box - slower for visibility
}

// Animate snake slide (shake effect then move down)
function animateSnakeSlide(playerIndex, fromPos, toPos, callback) {
    const token = document.querySelector(`.player-token[data-player-index="${playerIndex}"]`);
    SoundFX.snake();
    if (token) {
        // Shake effect
        token.style.animation = 'shake 0.5s';
        
        setTimeout(() => {
            token.style.animation = '';
            // Slide down
            animatePlayerMovement(playerIndex, fromPos, toPos, callback);
        }, 500);
    } else {
        animatePlayerMovement(playerIndex, fromPos, toPos, callback);
    }
}

// Animate ladder climb (bounce effect then move up)
function animateLadderClimb(playerIndex, fromPos, toPos, callback) {
    const token = document.querySelector(`.player-token[data-player-index="${playerIndex}"]`);
    SoundFX.ladder();
    if (token) {
        // Bounce effect
        token.style.animation = 'bounce 0.5s';
        
        setTimeout(() => {
            token.style.animation = '';
            // Climb up
            animatePlayerMovement(playerIndex, fromPos, toPos, callback);
        }, 500);
    } else {
        animatePlayerMovement(playerIndex, fromPos, toPos, callback);
    }
}

// Update single player token position
function updateSinglePlayerToken(playerIndex, position) {
    // Remove existing token for this player
    const existingToken = document.querySelector(`.player-token[data-player-index="${playerIndex}"]`);
    if (existingToken) {
        existingToken.remove();
    }
    
    if (position > 0) {
        const cell = document.querySelector(`[data-cell-number="${position}"]`);
        if (cell) {
            const token = document.createElement('div');
            token.className = 'player-token';
            token.dataset.playerIndex = playerIndex;
            token.title = currentState.players[playerIndex].name;
            styleToken(token, currentState.players[playerIndex], playerColors[playerIndex] || '#667eea');
            
            // Slot the token into the cell's stack (the animating token goes on top)
            const existingTokens = cell.querySelectorAll('.player-token').length;
            positionTokenInCell(token, existingTokens, existingTokens + 1);
            
            cell.appendChild(token);
        }
    }
}

socket.on('turnChanged', (state) => {
    console.log('Turn changed:', state.currentPlayer?.name);
    
    detectRankChanges(state);
    
    currentState = state;
    
    // Update my player ID if needed
    const myPlayer = state.players.find(p => p.id === socket.id) ||
        state.players.find(p => p.name === playerName);
    if (myPlayer) {
        myPlayerId = myPlayer.id;
        sessionStorage.setItem('playerId', myPlayer.id);
    }
    
    // Only re-place tokens when no animation is running (otherwise we'd teleport the token)
    if (!isAnimating) {
        updatePlayerTokens(currentState);
    }
    
    // Always update the side panel and turn info
    updatePlayersList(state);
    
    // Update turn info
    if (state.currentPlayer) {
        const playerIndex = state.players.findIndex(p => p.id === state.currentPlayer.id);
        const color = playerColors[playerIndex] || '#667eea';
        currentPlayerName.textContent = state.currentPlayer.name;
        currentPlayerName.style.color = color;
    }
    
    // Enable/disable roll button
    const isMyTurn = state.currentPlayer && state.currentPlayer.id === myPlayerId;
    rollDiceBtn.disabled = !isMyTurn;
    
    // Update pull skill button
    const myP = state.players.find(p => p.id === myPlayerId);
    if (myP) {
        pullSkillBtn.disabled = !isMyTurn || myP.pullUsed;
        const statusSpan = pullSkillBtn.querySelector('.skill-status');
        statusSpan.textContent = myP.pullUsed ? '(Used)' : '(Available)';
    }
    
    diceResult.textContent = '';
});

socket.on('pullUsed', (data) => {
    SoundFX.pull();
    // data.message comes from the server: "X pulled Y from A to B"
    addLogEntry(`⚡ ${data.message}`, 'pull');
    currentState = data.state;
    updateGameState(currentState);
    updatePlayerTokens(currentState);
});

socket.on('pullError', (data) => {
    addLogEntry(`Pull failed: ${data.message}`, 'error');
});

socket.on('shieldBattleStarted', (data) => {
    SoundFX.battleStart();
    shieldBattleActive = true;
    myPresses = 0;
    battleStartTime = Date.now();
    
    // Find player names
    const attacker = currentState.players.find(p => p.id === data.attacker);
    const defender = currentState.players.find(p => p.id === data.defender);
    
    attackerName.textContent = attacker ? attacker.name : 'Attacker';
    defenderName.textContent = defender ? defender.name : 'Defender';
    attackerPresses.textContent = '0';
    defenderPresses.textContent = '0';
    attackerBar.style.width = '0%';
    defenderBar.style.width = '0%';
    
    shieldBattleModal.classList.remove('hidden');
    
    // Start timer
    timerFill.style.width = '100%';
    battleTimer = setInterval(() => {
        const elapsed = Date.now() - battleStartTime;
        const remaining = Math.max(0, data.duration - elapsed);
        const percentage = (remaining / data.duration) * 100;
        timerFill.style.width = percentage + '%';
        
        if (remaining <= 0) {
            clearInterval(battleTimer);
            endShieldBattle();
        }
    }, 50);
    
    addLogEntry('Shield Battle started! Press SPACEBAR rapidly!');
});

socket.on('shieldBattleUpdate', (data) => {
    attackerPresses.textContent = data.attackerPresses;
    defenderPresses.textContent = data.defenderPresses;
    
    // Update bars (max expected presses ~30 in 3 seconds)
    const maxPresses = 30;
    attackerBar.style.width = Math.min(100, (data.attackerPresses / maxPresses) * 100) + '%';
    defenderBar.style.width = Math.min(100, (data.defenderPresses / maxPresses) * 100) + '%';
});

function endShieldBattle() {
    socket.emit('shieldBattleEnd');
}

socket.on('shieldBattleEnded', (data) => {
    shieldBattleActive = false;
    clearInterval(battleTimer);
    shieldBattleModal.classList.add('hidden');
    
    const message = `${data.winnerName} won the shield battle with ${data.winner === 'attacker' ? data.attackerPresses : data.defenderPresses} presses!`;
    addLogEntry(message);
    
    updateGameState(data.state);
});

socket.on('gameOver', (data) => {
    if (data.winner) {
        winnerName.textContent = `${data.winner} wins!`;
        const winnerIsMe = currentState.players.some(p => p.name === data.winner && p.id === myPlayerId);
        if (winnerIsMe) {
            SoundFX.win();
            launchConfetti();
        } else {
            SoundFX.lose();
        }
    } else {
        winnerName.textContent = data.message || 'Game ended';
        SoundFX.lose();
    }
    gameOverModal.classList.remove('hidden');
});

// Confetti burst for the winner 🎉
function launchConfetti() {
    let container = document.getElementById('confettiContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'confettiContainer';
        container.className = 'confetti-container';
        document.body.appendChild(container);
    }
    container.innerHTML = '';
    const colors = ['#e91e63', '#2196f3', '#4caf50', '#ff9800', '#9c27b0', '#ffeb3b', '#00bcd4'];
    for (let i = 0; i < 80; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + 'vw';
        piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = Math.random() * 0.8 + 's';
        piece.style.animationDuration = 2 + Math.random() * 2 + 's';
        piece.style.width = piece.style.height = (6 + Math.random() * 8) + 'px';
        container.appendChild(piece);
    }
    setTimeout(() => { container.innerHTML = ''; }, 5000);
}

socket.on('gameState', (state) => {
    console.log('Game state received:', state);
    updateGameState(state);
});

socket.on('gameStarted', (state) => {
    console.log('Game started:', state);
    currentState = state;
    
    // Find my player ID
    const myPlayer = state.players.find(p => p.name === playerName);
    if (myPlayer) {
        myPlayerId = myPlayer.id;
    }
    
    updateGameState(state);
});

socket.on('connect', () => {
    console.log('Connected to server, socket id:', socket.id);
    
    // Rejoin room with new socket ID
    if (roomCode && playerName) {
        console.log('Rejoining room:', roomCode, 'as', playerName);
        socket.emit('rejoinRoom', { roomCode, playerName, playerId: myStoredPlayerId, avatar: myAvatar }, (response) => {
            if (response.success) {
                console.log('Rejoined room successfully:', response.gameState);
                currentState = response.gameState;
                
                // Update my player ID from the new game state
                const myPlayer = currentState.players.find(p => p.id === socket.id) ||
                    currentState.players.find(p => p.name === playerName);
                if (myPlayer) {
                    myPlayerId = myPlayer.id;
                    sessionStorage.setItem('playerId', myPlayer.id);
                    console.log('My player ID:', myPlayerId);
                }
                
                updateGameState(currentState);
                addLogEntry('Connected to game!');
            } else {
                console.error('Failed to rejoin room:', response.message);
                alert('Failed to reconnect to game: ' + response.message);
                window.location.href = '/';
            }
        });
    }
});

// Initialize game when page loads
initGame();
