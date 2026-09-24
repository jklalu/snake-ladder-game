// Lobby Client Script
const socket = io();

// DOM Elements
const initialScreen = document.getElementById('initialScreen');
const waitingRoom = document.getElementById('waitingRoom');
const playerNameInput = document.getElementById('playerName');
const createRoomBtn = document.getElementById('createRoomBtn');
const showJoinBtn = document.getElementById('showJoinBtn');
const joinForm = document.getElementById('joinForm');
const roomCodeInput = document.getElementById('roomCode');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const displayRoomCode = document.getElementById('displayRoomCode');
const playerCount = document.getElementById('playerCount');
const playersList = document.getElementById('playersList');
const startGameBtn = document.getElementById('startGameBtn');
const waitingMessage = document.getElementById('waitingMessage');
const testModeBtn = document.getElementById('testModeBtn');
const avatarInput = document.getElementById('avatarInput');
const avatarPreview = document.getElementById('avatarPreview');

let isHost = false;
let currentRoom = null;
let playerName = null;
let playerAvatar = null; // downscaled dataURL of the profile picture

// Profile picture: pick, downscale to 96px square (keeps socket payloads small)
avatarInput.addEventListener('change', () => {
    const file = avatarInput.files[0];
    if (!file) return;
    
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Center-crop to square before scaling
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        playerAvatar = canvas.toDataURL('image/jpeg', 0.8);
        avatarPreview.textContent = '';
        avatarPreview.style.backgroundImage = `url(${playerAvatar})`;
        URL.revokeObjectURL(url);
    };
    img.onerror = () => {
        alert('Could not load that image');
        URL.revokeObjectURL(url);
    };
    img.src = url;
});

// Show join form
showJoinBtn.addEventListener('click', () => {
    joinForm.classList.toggle('hidden');
});

// Create room
createRoomBtn.addEventListener('click', () => {
    playerName = playerNameInput.value.trim();
    if (!playerName) {
        alert('Please enter your name');
        return;
    }
    
    socket.emit('createRoom', { playerName, avatar: playerAvatar }, (response) => {
        if (response.success) {
            currentRoom = response.roomCode;
            isHost = true;
            showWaitingRoom();
        } else {
            alert('Failed to create room');
        }
    });
});

// Join room
joinRoomBtn.addEventListener('click', () => {
    playerName = playerNameInput.value.trim();
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    
    if (!playerName) {
        alert('Please enter your name');
        return;
    }
    
    if (!roomCode) {
        alert('Please enter room code');
        return;
    }
    
    socket.emit('joinRoom', { playerName, roomCode, avatar: playerAvatar }, (response) => {
        if (response.success) {
            currentRoom = response.roomCode;
            isHost = false;
            showWaitingRoom();
        } else {
            alert(response.message);
        }
    });
});

// Start game (host only)
startGameBtn.addEventListener('click', () => {
    if (isHost) {
        socket.emit('startGame');
    }
});

// Test mode
testModeBtn.addEventListener('click', () => {
    playerName = playerNameInput.value.trim();
    if (!playerName) {
        alert('Please enter your name');
        return;
    }
    
    socket.emit('testMode', { playerName, avatar: playerAvatar }, (response) => {
        if (response.success) {
            currentRoom = response.roomCode;
            isHost = true;
            
            // Store ALL game data before redirect
            sessionStorage.setItem('roomCode', currentRoom);
            sessionStorage.setItem('playerName', playerName);
            sessionStorage.setItem('isHost', 'true');
            if (playerAvatar) sessionStorage.setItem('avatar', playerAvatar);
            sessionStorage.setItem('gameState', JSON.stringify(response.gameState));
            
            console.log('Test mode - storing game state:', response.gameState);
            
            // Go to game page
            window.location.href = '/game.html';
        } else {
            alert('Failed to start test mode');
        }
    });
});

// Show waiting room
function showWaitingRoom() {
    initialScreen.classList.add('hidden');
    waitingRoom.classList.remove('hidden');
    displayRoomCode.textContent = currentRoom;
    
    if (isHost) {
        startGameBtn.classList.remove('hidden');
        waitingMessage.textContent = 'Waiting for players... (min 2 players)';
    } else {
        startGameBtn.classList.add('hidden');
        waitingMessage.textContent = 'Waiting for host to start the game...';
    }
}

// Update players list
function updatePlayersList(players) {
    playersList.innerHTML = '';
    playerCount.textContent = players.length;
    
    players.forEach(player => {
        const li = document.createElement('li');
        li.className = 'lobby-player-item';
        
        if (player.avatar) {
            const img = document.createElement('img');
            img.className = 'lobby-player-avatar';
            img.src = player.avatar;
            img.alt = '';
            li.appendChild(img);
        }
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = player.name + (player.id === socket.id ? ' (You)' : '');
        li.appendChild(nameSpan);
        
        playersList.appendChild(li);
    });
    
    // Enable start button if enough players
    if (isHost && players.length >= 2) {
        startGameBtn.disabled = false;
        waitingMessage.textContent = 'Ready to start!';
    } else if (isHost) {
        startGameBtn.disabled = true;
        waitingMessage.textContent = 'Waiting for players... (min 2 players)';
    }
}

// Socket event listeners
socket.on('playerJoined', (data) => {
    updatePlayersList(data.players);
    addLogEntry(`${data.playerName} joined the room`);
});

socket.on('playerLeft', (data) => {
    updatePlayersList(data.players);
    addLogEntry(`${data.playerName} left the room`);
});

socket.on('gameStarted', (gameState) => {
    // Store game state in sessionStorage
    sessionStorage.setItem('gameState', JSON.stringify(gameState));
    sessionStorage.setItem('roomCode', currentRoom);
    sessionStorage.setItem('playerName', playerName);
    sessionStorage.setItem('isHost', isHost);
    if (playerAvatar) sessionStorage.setItem('avatar', playerAvatar);
    
    // Store my stable player id so rejoin after the redirect matches me exactly
    const me = (gameState.players || []).find(p => p.name === playerName);
    if (me) sessionStorage.setItem('playerId', me.id);
    
    // Redirect to game page
    window.location.href = '/game.html';
});

socket.on('roomClosed', () => {
    alert('Host left the room. Room closed.');
    window.location.reload();
});

socket.on('error', (data) => {
    alert(data.message);
});

// Add log entry (for debugging)
function addLogEntry(message) {
    console.log(message);
}

// Handle page unload
window.addEventListener('beforeunload', () => {
    // Socket will automatically disconnect
});
