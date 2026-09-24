// Game Logic for Snake and Ladder

class Game {
    constructor(roomId, hostId) {
        this.roomId = roomId;
        this.hostId = hostId;
        this.players = [];
        this.currentTurn = 0;
        this.gameStarted = false;
        this.winner = null;
        
        // Board configuration - 9 snakes
        this.snakes = {
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
        this.ladders = {
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
        
        // Custom dice with negative numbers
        this.diceFaces = [-2, -1, 1, 2, 3, 4, 5, 6];
        
        // Shield battle state
        this.shieldBattle = null;
    }
    
    addPlayer(playerId, name, avatar) {
        this.players.push({
            id: playerId,
            name: name,
            avatar: avatar || null,
            position: 0,
            pullUsed: false,
            turnsTaken: 0,
            shieldAvailable: true
        });
    }
    
    removePlayer(playerId) {
        const idx = this.players.findIndex(p => p.id === playerId);
        if (idx === -1) return;
        
        this.players.splice(idx, 1);
        
        // Keep the turn pointer on the right player after the shift
        if (this.players.length === 0) {
            this.currentTurn = 0;
        } else if (idx < this.currentTurn) {
            this.currentTurn--;
        }
        if (this.currentTurn >= this.players.length) {
            this.currentTurn = 0;
        }
    }
    
    rollDice() {
        const randomIndex = Math.floor(Math.random() * this.diceFaces.length);
        return this.diceFaces[randomIndex];
    }
    
    getCurrentPlayer() {
        return this.players[this.currentTurn];
    }
    
    getPlayerById(playerId) {
        return this.players.find(p => p.id === playerId);
    }
    
    // Called at the START of a player's turn (1 turn == 1 dice roll here).
    // Counts the turn and regenerates the Pull skill every 6th turn so it is a
    // periodic ability, not a permanent one-shot. Returns true if it just regenerated.
    beginTurn(playerId) {
        const player = this.getPlayerById(playerId);
        if (!player) return false;
        player.turnsTaken = (player.turnsTaken || 0) + 1;
        if (player.turnsTaken % 6 === 0) {
            const regenerated = player.pullUsed;
            player.pullUsed = false;
            return regenerated;
        }
        return false;
    }
    
    // Check if position has a snake
    getSnakeTail(headPosition) {
        return this.snakes[headPosition] || null;
    }
    
    // Check if position has a ladder
    getLadderTop(bottomPosition) {
        return this.ladders[bottomPosition] || null;
    }
    
    // Move player with dice value
    movePlayer(playerId, diceValue) {
        const player = this.getPlayerById(playerId);
        if (!player) return { error: 'Player not found' };
        
        let newPosition = player.position + diceValue;
        
        // Boundary checks
        if (newPosition < 0) {
            newPosition = 0;
        }
        if (newPosition > 100) {
            // Can't move beyond 100
            return { 
                success: false, 
                message: 'Cannot move beyond 100',
                position: player.position
            };
        }
        
        player.position = newPosition;
        
        // Check for win
        if (newPosition === 100) {
            this.winner = player;
            this.gameStarted = false;
            return { 
                success: true, 
                position: newPosition, 
                winner: player,
                message: `${player.name} wins!`
            };
        }
        
        // Check for snake
        const snakeTail = this.getSnakeTail(newPosition);
        if (snakeTail) {
            return {
                success: true,
                position: newPosition,
                snake: true,
                snakeTail: snakeTail,
                message: `Snake at ${newPosition}! Slide down to ${snakeTail}`
            };
        }
        
        // Check for ladder
        const ladderTop = this.getLadderTop(newPosition);
        if (ladderTop) {
            player.position = ladderTop;
            return {
                success: true,
                position: newPosition,
                ladder: true,
                ladderTop: ladderTop,
                finalPosition: ladderTop,
                message: `Ladder at ${newPosition}! Climb up to ${ladderTop}`
            };
        }
        
        return {
            success: true,
            position: newPosition,
            message: `Moved to ${newPosition}`
        };
    }
    
    // Apply snake slide (after shield battle if defender loses)
    applySnakeSlide(playerId, tailPosition) {
        const player = this.getPlayerById(playerId);
        if (player) {
            player.position = tailPosition;
        }
    }
    
    // Pull skill - pull another player to your position
    pullPlayer(casterId, targetId) {
        const caster = this.getPlayerById(casterId);
        const target = this.getPlayerById(targetId);
        
        if (!caster || !target) {
            return { error: 'Player not found' };
        }
        
        if (caster.pullUsed) {
            return { error: 'Pull skill already used' };
        }
        
        if (caster.id === target.id) {
            return { error: 'Cannot pull yourself' };
        }
        
        caster.pullUsed = true;
        const oldPosition = target.position;
        target.position = caster.position;
        
        return {
            success: true,
            caster: caster.name,
            target: target.name,
            fromPosition: oldPosition,
            toPosition: caster.position,
            message: `${caster.name} pulled ${target.name} to position ${caster.position}`
        };
    }
    
    // Next turn
    nextTurn() {
        this.currentTurn = (this.currentTurn + 1) % this.players.length;
    }
    
    // Get game state
    getState() {
        return {
            roomId: this.roomId,
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                position: p.position,
                pullUsed: p.pullUsed,
                turnsTaken: p.turnsTaken,
                shieldAvailable: p.shieldAvailable
            })),
            currentTurn: this.currentTurn,
            currentPlayer: this.getCurrentPlayer(),
            gameStarted: this.gameStarted,
            winner: this.winner ? this.winner.name : null,
            snakes: this.snakes,
            ladders: this.ladders
        };
    }
    
    // Start game
    start() {
        if (this.players.length >= 2) {
            this.gameStarted = true;
            this.currentTurn = 0;
            return true;
        }
        return false;
    }
}

module.exports = Game;
