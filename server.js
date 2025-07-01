// server.js - Complete Backend with All Functionality Restored
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', true);

// Production security and optimization middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://download.agora.io"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"]
    }
  }
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 
    [process.env.FRONTEND_URL] : 
    ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000"],
  credentials: true
}));

// Body parsing with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static('.', {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0'
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeGames: gameManager ? gameManager.getActiveGameCount() : 0,
    connectedPlayers: gameManager ? gameManager.getConnectedPlayerCount() : 0,
    uptime: process.uptime()
  });
});

// Serve the game at root path
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Direct URL joining route
app.get('/join/:friendCode', (req, res) => {
    const friendCode = req.params.friendCode;
    res.redirect(`/?join=${friendCode}`);
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? 
      [process.env.FRONTEND_URL] : 
      ["http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST"]
  },
  // Production-optimized settings
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
  httpCompression: true,
  perMessageDeflate: true
});

// Game managers
let gameManager;
let contactManager;

// Production monitoring
const serverStats = {
  startTime: Date.now(),
  totalConnections: 0,
  activeConnections: 0,
  totalGames: 0,
  peakConcurrentGames: 0,
  errors: 0
};

// Contact system for friend codes
class ContactManager {
  constructor() {
    this.friendCodes = new Map();
    this.userFriends = new Map();
    this.onlineUsers = new Map();
    
    // Production cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000); // Cleanup every 5 minutes
  }

  cleanup() {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes
    
    for (const [userId, user] of this.onlineUsers.entries()) {
      if (now - user.lastSeen > staleThreshold) {
        this.removeUser(userId);
      }
    }
  }

  addUser(userId, name, socketId) {
    this.onlineUsers.set(userId, { 
      name, 
      socketId, 
      lastSeen: Date.now() 
    });
  }

  removeUser(userId) {
    this.onlineUsers.delete(userId);
    
    // Cleanup friend codes
    for (const [code, id] of this.friendCodes.entries()) {
      if (id === userId) {
        this.friendCodes.delete(code);
      }
    }
  }

  generateFriendCode(userId) {
    const code = 'FC' + userId.slice(-6).toUpperCase();
    this.friendCodes.set(code, userId);
    return code;
  }

  addFriendByCode(userId, friendCode, userName) {
    const friendId = this.friendCodes.get(friendCode);
    if (!friendId) {
      throw new Error(`Friend code ${friendCode} not found`);
    }

    if (friendId === userId) {
      throw new Error('Cannot add yourself as friend');
    }

    if (!this.userFriends.has(userId)) {
      this.userFriends.set(userId, new Set());
    }
    if (!this.userFriends.has(friendId)) {
      this.userFriends.set(friendId, new Set());
    }

    this.userFriends.get(userId).add(friendId);
    this.userFriends.get(friendId).add(userId);

    return this.onlineUsers.get(friendId);
  }

  getFriends(userId) {
    const friendIds = this.userFriends.get(userId) || new Set();
    return Array.from(friendIds).map(friendId => {
      const user = this.onlineUsers.get(friendId);
      return {
        id: friendId,
        name: user ? user.name : 'Unknown',
        online: !!user
      };
    });
  }
}

// Production-optimized Game Manager
class GameManager {
  constructor() {
    this.games = new Map();
    this.playerGameMap = new Map();
    this.publicGames = new Map();
    this.gameCleanupInterval = null;
    
    // Start cleanup process
    this.startCleanup();
  }

  startCleanup() {
    this.gameCleanupInterval = setInterval(() => {
      this.cleanupStaleGames();
    }, 2 * 60 * 1000); // Cleanup every 2 minutes
  }

  cleanupStaleGames() {
    const now = Date.now();
    const staleThreshold = 60 * 60 * 1000; // 1 hour
    const emptyGameThreshold = 10 * 60 * 1000; // 10 minutes for empty games
    
    for (const [gameId, game] of this.games.entries()) {
      const gameAge = now - game.createdAt;
      const connectedPlayers = game.players.filter(p => p.connected !== false);
      
      // Remove very old games or empty games
      if (gameAge > staleThreshold || 
          (connectedPlayers.length === 0 && gameAge > emptyGameThreshold)) {
        console.log(`Cleaning up stale game: ${gameId}`);
        this.removeGame(gameId);
      }
    }
    
    // Update stats
    const currentGameCount = this.games.size;
    if (currentGameCount > serverStats.peakConcurrentGames) {
      serverStats.peakConcurrentGames = currentGameCount;
    }
  }

  createGame(gameId, hostId, settings = {}) {
    const game = new Game(gameId, hostId, settings);
    this.games.set(gameId, game);
    this.playerGameMap.set(hostId, gameId);
    serverStats.totalGames++;
    return game;
  }

  addPublicGame(game, hostName) {
    this.publicGames.set(game.id, {
      id: game.id,
      hostName: hostName,
      playerCount: game.players.length,
      maxPlayers: game.maxPlayers,
      round: game.round,
      state: game.state,
      settings: game.settings,
      createdAt: game.createdAt
    });
  }

  updatePublicGame(gameId) {
    const game = this.games.get(gameId);
    if (game && game.settings.isPublic) {
      const publicGame = this.publicGames.get(gameId);
      if (publicGame) {
        publicGame.playerCount = game.players.length;
        publicGame.round = game.round;
        publicGame.state = game.state;
      }
    }
  }

  getPublicGames() {
    return Array.from(this.publicGames.values())
      .filter(game => game.state === 'waiting' || game.state === 'playing')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
  }

  getGame(gameId) {
    return this.games.get(gameId);
  }

  getAllGames() {
    return Array.from(this.games.values());
  }

  removeGame(gameId) {
    const game = this.games.get(gameId);
    if (game) {
      game.players.forEach(player => {
        this.playerGameMap.delete(player.id);
      });
      this.games.delete(gameId);
      this.publicGames.delete(gameId);
    }
  }

  getActiveGameCount() {
    return this.games.size;
  }

  getConnectedPlayerCount() {
    let count = 0;
    for (const game of this.games.values()) {
      count += game.players.filter(p => p.connected !== false).length;
    }
    return count;
  }

  getPlayerGame(playerId) {
    const gameId = this.playerGameMap.get(playerId);
    return gameId ? this.games.get(gameId) : null;
  }
}

// Complete Game class with all functionality
class Game {
  constructor(id, hostId, settings = {}) {
    this.id = id;
    this.hostId = hostId;
    this.players = [];
    this.spectators = [];
    this.dealerIndex = 0;
    this.currentPlayerIndex = 1;
    this.round = 1;
    this.maxPlayers = Math.min(settings.maxPlayers || 8, 30);
    this.state = 'waiting';
    this.turnPhase = 'trading';
    this.deck = [];
    this.playersWhoActed = new Set();
    this.settings = {
      startingLives: settings.startingLives || 3,
      deckCount: settings.deckCount || 1,
      tournamentMode: settings.tournamentMode || 'single',
      cardStyle: settings.cardStyle || 'classic',
      allowSpectatorBetting: settings.allowSpectatorBetting || true,
      type: settings.type || 'public',
      password: settings.password || null,
      isPublic: settings.isPublic || false,
      ...settings
    };
    this.roundHistory = [];
    this.spectatorBets = [];
    this.gameCode = this.generateGameCode();
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  generateGameCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  async addPlayer(player) {
    if (this.isFull()) throw new Error('Game is full');
    if (this.hasStarted()) throw new Error('Game already started');

    this.updateActivity();

    const existingPlayer = this.players.find(p => p.id === player.id);
    if (existingPlayer) {
      existingPlayer.socketId = player.socketId;
      existingPlayer.connected = true;
      existingPlayer.name = player.name;
      existingPlayer.avatar = player.avatar;
      existingPlayer.lastSeen = Date.now();
      return existingPlayer;
    }

    const newPlayer = {
      ...player,
      lives: this.settings.startingLives,
      card: null,
      cardRevealed: false,
      hasTraded: false,
      connected: true,
      lastSeen: Date.now(),
      stats: {
        roundsWon: 0,
        roundsLost: 0,
        tradesInitiated: 0,
        tradesBlocked: 0
      }
    };

    this.players.push(newPlayer);
    return newPlayer;
  }

  addSpectator(spectator) {
    this.spectators.push({
      ...spectator,
      joinedAt: Date.now()
    });
    this.updateActivity();
  }

  removeSpectator(spectatorId) {
    this.spectators = this.spectators.filter(s => s.id !== spectatorId);
  }

  async startGame(customSettings = {}) {
    if (this.players.length < 2) throw new Error('Need at least 2 players');
    
    this.settings = { ...this.settings, ...customSettings };
    this.updateActivity();
    
    this.initializeDeck();
    this.shuffleDeck();
    this.dealCards();
    this.state = 'playing';
    this.dealerIndex = 0;
    this.currentPlayerIndex = 1;
    this.turnPhase = 'trading';
  }

  initializeDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = [
      { value: 'A', numValue: 1 },
      { value: '2', numValue: 2 },
      { value: '3', numValue: 3 },
      { value: '4', numValue: 4 },
      { value: '5', numValue: 5 },
      { value: '6', numValue: 6 },
      { value: '7', numValue: 7 },
      { value: '8', numValue: 8 },
      { value: '9', numValue: 9 },
      { value: '10', numValue: 10 },
      { value: 'J', numValue: 11 },
      { value: 'Q', numValue: 12 },
      { value: 'K', numValue: 13 }
    ];

    this.deck = [];
    for (let deckNum = 0; deckNum < this.settings.deckCount; deckNum++) {
      for (const suit of suits) {
        for (const cardValue of values) {
          this.deck.push({
            suit,
            ...cardValue,
            id: `${cardValue.value}_${suit}_${deckNum}`
          });
        }
      }
    }
  }

  shuffleDeck() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  dealCards() {
    const activePlayers = this.players.filter(p => p.lives > 0);
    
    if (this.deck.length < activePlayers.length) {
      this.initializeDeck();
      this.shuffleDeck();
    }

    activePlayers.forEach(player => {
      player.card = this.deck.pop();
      player.cardRevealed = false;
      player.hasTraded = false;
    });

    this.playersWhoActed.clear();
    this.turnPhase = 'trading';
    this.updateActivity();
  }

  advanceToNextPlayer() {
    const activePlayers = this.players.filter(p => p.lives > 0);
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % activePlayers.length;
    
    if (this.currentPlayerIndex === this.dealerIndex) {
      this.turnPhase = 'dealer-turn';
    }
    
    const nonDealerCount = activePlayers.length - 1;
    if (this.playersWhoActed.size >= nonDealerCount) {
      this.turnPhase = 'dealer-turn';
    }
    
    this.updateActivity();
  }

  async requestTrade(fromPlayerId, toPlayerId, direction) {
    this.updateActivity();
    
    const fromPlayer = this.players.find(p => p.id === fromPlayerId);
    const toPlayer = this.players.find(p => p.id === toPlayerId);
    
    if (!fromPlayer || !toPlayer) throw new Error('Player not found');
    if (this.turnPhase !== 'trading') throw new Error('Not in trading phase');
    
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    if (fromPlayer.id !== currentPlayer.id) {
        throw new Error('Not your turn to trade');
    }
    
    if (this.playersWhoActed.has(fromPlayerId)) {
        throw new Error('You have already acted this turn');
    }
    
    const fromIndex = activePlayers.findIndex(p => p.id === fromPlayerId);
    // Find the valid trade target (allowing King bypass)
    let nextIndex = (fromIndex + 1) % activePlayers.length;
    let nextPlayer = activePlayers[nextIndex];

    // Check if we need to bypass Kings
    while (nextPlayer.card && nextPlayer.card.value === 'K' && nextPlayer.cardRevealed) {
      // Special case: If dealer has King, can't bypass - must trade with deck
      const isDealerWithKing = nextPlayer.id === activePlayers[this.dealerIndex].id;
      if (isDealerWithKing) {
        break; // Stop here - dealer King is handled later
      }

      // Bypass non-dealer King holders
      console.log(`👑 Server: Bypassing ${nextPlayer.name} (has revealed King)`);
      nextIndex = (nextIndex + 1) % activePlayers.length;
      nextPlayer = activePlayers[nextIndex];

      // Prevent infinite loop
      if (nextIndex === fromIndex) break;
    }
    
    if (nextPlayer.id !== toPlayerId) {
        throw new Error('You can only trade with the next player');
    }
    
    // Game logic for trading
    const hasJack = toPlayer.card && toPlayer.card.value === 'J';
    const hasKing = toPlayer.card && toPlayer.card.value === 'K';
    
    // CRITICAL FIX: Check if target is dealer with King
    const isDealerTarget = toPlayer.id === activePlayers[this.dealerIndex].id;
    
    let traded = false;
    let blocked = false;
    let kingRevealed = false;
    let tradedWithDeck = false;
    let deckCard = null;
    
    if (hasJack) {
        // Jack blocks the trade - "Screw You!"
        blocked = true;
        toPlayer.cardRevealed = true;
        toPlayer.stats.tradesBlocked++;
        console.log(`🚫 ${toPlayer.name}'s Jack blocks ${fromPlayer.name}'s trade!`);
    } else if (hasKing && isDealerTarget) {
        // SPECIAL RULE: Dealer with King = trade with deck instead!
        if (this.deck.length === 0) {
            throw new Error('No cards left in deck');
        }
        
        deckCard = this.deck.pop();
        const playerCard = fromPlayer.card;
        fromPlayer.card = deckCard;
        
        tradedWithDeck = true;
        toPlayer.cardRevealed = true; // Reveal dealer's King
        fromPlayer.cardRevealed = true;
        fromPlayer.stats.tradesInitiated++;
        
        console.log(`👑🎴 SPECIAL: ${fromPlayer.name} trades with deck because dealer ${toPlayer.name} has King!`);
    } else if (hasKing) {
        // Regular King - reveal and pass to next player
        kingRevealed = true;
        toPlayer.cardRevealed = true;
        
        console.log(`👑 ${toPlayer.name}'s King revealed - ${fromPlayer.name} can pass to next player`);
        
        // Find next player after the King holder
        const kingHolderIndex = activePlayers.findIndex(p => p.id === toPlayer.id);
        const nextAfterKingIndex = (kingHolderIndex + 1) % activePlayers.length;
        const nextAfterKing = activePlayers[nextAfterKingIndex];
        
        // Check if next player after King has Jack
        if (nextAfterKing.card && nextAfterKing.card.value === 'J') {
            nextAfterKing.cardRevealed = true;
            this.playersWhoActed.add(fromPlayerId);
            this.turnPhase = 'revealing';
            console.log(`🚫 ${nextAfterKing.name}'s Jack blocks pass-through! Round ends.`);
        }
    } else {
        // Normal trade - swap cards
        const tempCard = fromPlayer.card;
        fromPlayer.card = toPlayer.card;
        toPlayer.card = tempCard;
        traded = true;
        fromPlayer.stats.tradesInitiated++;
        fromPlayer.cardRevealed = true;
        
        console.log(`🔄 Normal trade: ${fromPlayer.name} ↔ ${toPlayer.name}`);
    }
    
    // Mark player as having acted (unless King allows passing)
    if (!kingRevealed) {
        this.playersWhoActed.add(fromPlayerId);
        this.advanceToNextPlayer();
    }
    
    // In your requestTrade method, REPLACE the return statement with this:

    return {
      traded,
      blocked,
      kingRevealed,
      tradedWithDeck,
      deckCard,
      roundEnded: this.turnPhase === 'revealing',
      fromPlayer,      // Keep the objects for other uses
      toPlayer,        // Keep the objects for other uses
      fromPlayerId: fromPlayer.id,  // ADD: Player IDs for client
      toPlayerId: toPlayer.id       // ADD: Player IDs for client
    };
}

  async skipPlayerTurn(playerId) {
    this.updateActivity();
    
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');
    
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    if (player.id !== currentPlayer.id) {
      throw new Error('Not your turn');
    }
    
    const isKing = player.card && player.card.value === 'K';
    
    this.playersWhoActed.add(playerId);
    
    if (isKing) {
      player.cardRevealed = true;
    }
    
    this.advanceToNextPlayer();
    
    return { skipped: true, keptCard: true, wasKing: isKing };
  }

  async flipPlayerCard(playerId) {
    this.updateActivity();
    
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');
    
    player.cardRevealed = true;
    return player;
  }

  async dealerTradeWithDeck(dealerId) {
    this.updateActivity();
    
    const dealer = this.players.find(p => p.id === dealerId);
    if (!dealer) throw new Error('Dealer not found');
    
    const activePlayers = this.players.filter(p => p.lives > 0);
    const dealerIndex = activePlayers.findIndex(p => p.id === dealerId);
    
    if (dealerIndex !== this.dealerIndex) {
      throw new Error('Only the dealer can trade with the deck');
    }
    
    if (this.turnPhase !== 'dealer-turn') {
      throw new Error('Not dealer\'s turn');
    }

    if (this.deck.length === 0) {
      throw new Error('No cards left in deck');
    }

    const deckCard = this.deck.pop();
    const dealerCard = dealer.card;
    dealer.card = deckCard;
    dealer.cardRevealed = true;

    this.turnPhase = 'revealing';
    
    return { traded: true, newCard: deckCard, oldCard: dealerCard };
  }

  async dealerKingDeckTrade(fromPlayerId) {
    this.updateActivity();

    const fromPlayer = this.players.find(p => p.id === fromPlayerId);
    if (!fromPlayer) throw new Error('Player not found');

    if (this.deck.length === 0) {
      throw new Error('No cards left in deck');
    }

    const deckCard = this.deck.pop();
    fromPlayer.card = deckCard;
    fromPlayer.cardRevealed = true;

    // Reveal dealer's King
    const dealer = this.players[this.dealerIndex];
    dealer.cardRevealed = true;

    this.playersWhoActed.add(fromPlayerId);
    this.advanceToNextPlayer();

    console.log(`🎴 ${fromPlayer.name} trades with deck (dealer has King)`);

    return {
      tradedWithDeck: true,
      fromPlayer,
      deckCard
    };
  }

  async skipDealerTrade(dealerId) {
    this.updateActivity();
    
    const dealer = this.players.find(p => p.id === dealerId);
    if (!dealer) throw new Error('Dealer not found');
    
    const activePlayers = this.players.filter(p => p.lives > 0);
    const dealerIndex = activePlayers.findIndex(p => p.id === dealerId);
    
    if (dealerIndex !== this.dealerIndex) {
      throw new Error('Only the dealer can skip');
    }
    
    if (this.turnPhase !== 'dealer-turn') {
      throw new Error('Not dealer\'s turn');
    }

    this.turnPhase = 'revealing';
    
    return { skipped: true };
  }

  async endRound() {
    this.updateActivity();
    
    if (this.turnPhase !== 'revealing') {
        throw new Error('Cannot end round yet - still in trading phase');
    }
    
    const activePlayers = this.players.filter(p => p.lives > 0);
    
    activePlayers.forEach(player => {
        player.cardRevealed = true;
    });

    const lowestValue = Math.min(...activePlayers.map(p => p.card.numValue));
    const losers = activePlayers.filter(p => p.card.numValue === lowestValue);

    // CRITICAL FIX: Only subtract lives, never add them back!
    losers.forEach(player => {
        player.lives = Math.max(0, player.lives - 1); // Ensure lives never go below 0
        player.stats.roundsLost++;
        
        console.log(`Player ${player.name} lost a life. Lives remaining: ${player.lives}`);
        
        // Log elimination
        if (player.lives === 0) {
            console.log(`🚪 Player ${player.name} has been ELIMINATED from the game!`);
        }
    });

    activePlayers.filter(p => p.card.numValue > lowestValue).forEach(player => {
        player.stats.roundsWon++;
    });

    const roundResult = {
        round: this.round,
        losers: losers.map(p => ({ 
            id: p.id, 
            name: p.name, 
            card: p.card,
            livesRemaining: p.lives,
            eliminated: p.lives === 0
        })),
        lowestValue
    };

    this.roundHistory.push(roundResult);
    this.round++;

    if (!this.isFinished()) {
        // CRITICAL FIX: Only include players who still have lives > 0
        const remainingPlayers = this.players.filter(p => p.lives > 0);
        
        console.log(`Remaining players for next round: ${remainingPlayers.map(p => `${p.name}(${p.lives} lives)`).join(', ')}`);
        
        if (remainingPlayers.length < 2) {
            console.log(`Game ending - only ${remainingPlayers.length} players remaining`);
            return roundResult;
        }
        
        // Find new dealer among remaining players
        const currentDealerStillAlive = remainingPlayers.find(p => p.id === remainingPlayers[this.dealerIndex]?.id);
        
        if (!currentDealerStillAlive) {
            // Current dealer is eliminated, find next living player
            this.dealerIndex = 0;
        } else {
            this.dealerIndex = (this.dealerIndex + 1) % remainingPlayers.length;
        }
        
        this.currentPlayerIndex = (this.dealerIndex + 1) % remainingPlayers.length;
        
        console.log(`New dealer: ${remainingPlayers[this.dealerIndex]?.name}, First player: ${remainingPlayers[this.currentPlayerIndex]?.name}`);
        
        this.dealCards();
    }

    return roundResult;
}

  isFinished() {
    const alivePlayers = this.players.filter(p => p.lives > 0);
    return alivePlayers.length <= 1;
  }

  getWinner() {
    const alivePlayers = this.players.filter(p => p.lives > 0);
    return alivePlayers.length === 1 ? alivePlayers[0] : null;
  }

  getFinalStats() {
    return {
      totalRounds: this.round - 1,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        finalLives: p.lives,
        stats: p.stats
      })),
      roundHistory: this.roundHistory
    };
  }

  isFull() {
    return this.players.length >= this.maxPlayers;
  }

  hasStarted() {
    return this.state !== 'waiting';
  }

  handlePlayerDisconnect(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.connected = false;
      player.disconnectedAt = Date.now();
    }
    this.updateActivity();
  }

  getPublicState() {
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    const dealer = activePlayers[this.dealerIndex];
    
    return {
      id: this.id,
      gameCode: this.gameCode,
      hostId: this.hostId,
      state: this.state,
      round: this.round,
      settings: this.settings,
      turnPhase: this.turnPhase,
      currentPlayerId: currentPlayer ? currentPlayer.id : null,
      dealerId: dealer ? dealer.id : null,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        lives: p.lives,
        cardRevealed: p.cardRevealed,
        hasTraded: p.hasTraded,
        connected: p.connected !== false,
        hasCard: !!p.card,
        card: (p.cardRevealed || this.turnPhase === 'revealing') ? p.card : null,
        isDealer: this.players.filter(pl => pl.lives > 0)[this.dealerIndex]?.id === p.id
      })),
      spectators: this.spectators.map(s => ({
        id: s.id,
        name: s.name
      })),
      cardsRemaining: this.deck.length,
      currentPlayerIndex: this.currentPlayerIndex,
      dealerIndex: this.dealerIndex,
      maxPlayers: this.maxPlayers
    };
  }

  getPlayerView(playerId) {
    const state = this.getPublicState();
    
    // Add player-specific card data
    state.players = state.players.map(p => ({
      ...p,
      currentCard: p.id === playerId ? p.card : (this.shouldShowCardToPlayer(p, playerId) ? p.card : null)
    }));
    
    return state;
  }

  shouldShowCardToPlayer(cardOwner, viewingPlayerId) {
    if (this.turnPhase === 'revealing') return true;
    if (cardOwner.id === viewingPlayerId && cardOwner.cardRevealed) return true;
    if (cardOwner.cardRevealed && this.isCardPubliclyVisible(cardOwner.id)) return true;
    return false;
  }

  isCardPubliclyVisible(playerId) {
    return this.turnPhase === 'revealing';
  }
}

// Simple auth validation
const validateUserToken = async (token, providedName = null) => {
  if (token && token.startsWith('demo_token_')) {
    const userId = token.replace('demo_token_', '');
    return {
      id: userId,
      name: providedName || ('Player_' + userId.slice(-4)),
      avatar: 'default'
    };
  }
  return null;
};

// Helper function for game updates
function sendGameUpdateToAll(gameId, eventName, data = {}) {
  const game = gameManager.getGame(gameId);
  if (!game) return;
  
  // Batch updates for performance
  const updates = [];
  
  game.players.forEach(player => {
    if (player.connected && player.socketId) {
      updates.push({
        socketId: player.socketId,
        data: {
          ...data,
          game: game.getPlayerView(player.id)
        }
      });
    }
  });
  
  game.spectators.forEach(spectator => {
    if (spectator.socketId) {
      updates.push({
        socketId: spectator.socketId,
        data: {
          ...data,
          game: game.getPublicState()
        }
      });
    }
  });
  
  // Send all updates
  updates.forEach(update => {
    io.to(update.socketId).emit(eventName, update.data);
  });
}

// Socket.IO connection handling with production optimizations
io.on('connection', (socket) => {
  serverStats.totalConnections++;
  serverStats.activeConnections++;
  
  console.log(`User connected: ${socket.id} (Active: ${serverStats.activeConnections})`);

  // AUTO-REJOIN: Check if this is a reconnecting player
  socket.on('check-reconnect', (data) => {
    try {
      const { userId } = data;
      if (userId) {
        const existingGame = gameManager.getPlayerGame(userId);
        if (existingGame) {
          const player = existingGame.players.find(p => p.id === userId);
          if (player && !player.connected) {
            // This is a reconnecting player - auto-rejoin them
            socket.join(existingGame.id);
            socket.gameId = existingGame.id;
            socket.userId = userId;

            // Mark as reconnected
            player.connected = true;
            player.socketId = socket.id;
            delete player.disconnectedAt;

            console.log(`🔄 Auto-rejoined: ${player.name} to game ${existingGame.id}`);

            // Send them back into the game
            socket.emit('auto-rejoined', {
              game: existingGame.getPlayerView(userId)
            });

            // Notify others they're back
            socket.to(existingGame.id).emit('player-reconnected', {
              playerId: userId,
              playerName: player.name
            });
          }
        }
      }
    } catch (error) {
      console.error('Reconnect error:', error);
    }
  });
  
  // Heartbeat for connection monitoring
  socket.on('heartbeat', (data) => {
    socket.emit('heartbeat-ack', { 
      timestamp: Date.now(),
      serverTime: new Date().toISOString()
    });
  });

  // Generate friend code for new connections
  socket.on('get-friend-code', (data) => {
    const { userId, userName } = data;
    
    contactManager.addUser(userId, userName, socket.id);
    const friendCode = contactManager.generateFriendCode(userId);
    
    socket.emit('friend-code-generated', { friendCode });
  });

  // Quick Match Handler
  socket.on('quick-match', async (data) => {
    try {
      const { userId, token, playerName } = data;
      
      const user = await validateUserToken(token || `demo_token_${socket.id}`, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      const publicGames = gameManager.getPublicGames();
      let availableGame = null;
      
      for (let publicGameInfo of publicGames) {
        const game = gameManager.getGame(publicGameInfo.id);
        if (game && !game.hasStarted() && game.players.length < game.maxPlayers) {
          availableGame = game;
          break;
        }
      }
      
      const finalUserId = userId || socket.id;
      
      if (availableGame) {
        await availableGame.addPlayer({
          id: finalUserId,
          socketId: socket.id,
          name: user.name,
          avatar: user.avatar
        });
        
        socket.join(availableGame.id);
        socket.gameId = availableGame.id;
        socket.userId = finalUserId;
        
        contactManager.addUser(finalUserId, user.name, socket.id);
        
        socket.emit('game-joined', {
          game: availableGame.getPlayerView(finalUserId),
          gameType: 'public'
        });
        
        socket.to(availableGame.id).emit('player-joined', {
          game: availableGame.getPublicState(),
          newPlayer: { name: user.name, avatar: user.avatar }
        });
        
        gameManager.updatePublicGame(availableGame.id);
        
      } else {
        const gameId = uuidv4();
        
        const game = gameManager.createGame(gameId, finalUserId, {           
          isPublic: true,           
          type: 'public',           
          maxPlayers: 30
        });
        
        gameManager.addPublicGame(game, user.name);
        
        await game.addPlayer({
          id: finalUserId,
          socketId: socket.id,
          name: user.name,
          avatar: user.avatar
        });
        
        socket.join(gameId);
        socket.gameId = gameId;
        socket.userId = finalUserId;
        
        contactManager.addUser(finalUserId, user.name, socket.id);
        const friendCode = contactManager.generateFriendCode(finalUserId);
        
        socket.emit('public-game-created', {
          game: game.getPlayerView(finalUserId),
          friendCode: friendCode,
          gameType: 'public'
        });
      }
      
    } catch (error) {
      console.error('Error in quick-match:', error);
      serverStats.errors++;
      socket.emit('error', { message: error.message || 'Failed to create/join game' });
    }
  });

  // Create private game
  socket.on('create-private-game', async (data) => {
    try {
      const { userId, token, playerName, settings = {} } = data;
      
      const user = await validateUserToken(token || `demo_token_${socket.id}`, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      const gameId = uuidv4();
      const finalUserId = userId || socket.id;
      
      const game = gameManager.createGame(gameId, finalUserId, {
        ...settings,
        isPublic: false,
        type: 'private',
        maxPlayers: Math.min(settings.maxPlayers || 8, 30)
      });
      
      await game.addPlayer({
        id: finalUserId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });

      socket.join(gameId);
      socket.gameId = gameId;
      socket.userId = finalUserId;

      contactManager.addUser(finalUserId, user.name, socket.id);
      const friendCode = contactManager.generateFriendCode(finalUserId);
      
      const baseUrl = process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3001}`;
      
      socket.emit('private-game-created', {
        game: game.getPlayerView(finalUserId),
        friendCode: friendCode,
        shareableLink: `${baseUrl}/join/${friendCode}`,
        gameType: 'private'
      });
      
    } catch (error) {
      console.error('Error creating private game:', error);
      serverStats.errors++;
      socket.emit('error', { message: error.message || 'Failed to create private game' });
    }
  });

  // Join game
  socket.on('join-game', async (data) => {
    try {
      const { gameId, userId, token, playerName, friendCode } = data;
      
      const user = await validateUserToken(token || `demo_token_${socket.id}`, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      let game = null;
      if (gameId) {
        game = gameManager.getGame(gameId);
      } else if (friendCode) {
        const allGames = Array.from(gameManager.games.values());
        for (let g of allGames) {
          const gFriendCode = contactManager.generateFriendCode(g.hostId);
          if (gFriendCode === friendCode) {
            game = g;
            break;
          }
        }
      }

      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      if (game.players.length >= game.maxPlayers) {
        socket.emit('error', { message: 'Game is full' });
        return;
      }

      if (game.hasStarted()) {
        socket.emit('error', { message: 'Game has already started' });
        return;
      }

      const finalUserId = userId || socket.id;
      
      await game.addPlayer({
        id: finalUserId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });

      socket.join(game.id);
      socket.gameId = game.id;
      socket.userId = finalUserId;

      contactManager.addUser(finalUserId, user.name, socket.id);

      socket.emit('game-joined', {
        game: game.getPlayerView(finalUserId),
        rejoin: false
      });

      socket.to(game.id).emit('player-joined', {
        game: game.getPublicState(),
        newPlayer: { name: user.name, avatar: user.avatar }
      });

      if (game.settings.isPublic) {
        gameManager.updatePublicGame(game.id);
      }

    } catch (error) {
      console.error('Join game error:', error);
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  // Join by URL Handler
  socket.on('join-by-url', async (data) => {
    try {
      const { friendCode, userId, token, playerName } = data;
      
      const user = await validateUserToken(token || `demo_token_${socket.id}`, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      const allGames = Array.from(gameManager.games.values());
      let targetGame = null;
      
      for (let game of allGames) {
        const gFriendCode = contactManager.generateFriendCode(game.hostId);
        if (gFriendCode === friendCode) {
          targetGame = game;
          break;
        }
      }
      
      if (!targetGame) {
        socket.emit('error', { message: 'Game not found or has ended' });
        return;
      }
      
      if (targetGame.hasStarted()) {
        socket.emit('error', { message: 'Game has already started' });
        return;
      }
      
      if (targetGame.players.length >= targetGame.maxPlayers) {
        socket.emit('error', { message: 'Game is full' });
        return;
      }
      
      const finalUserId = userId || socket.id;
      
      await targetGame.addPlayer({
        id: finalUserId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });
      
      socket.join(targetGame.id);
      socket.gameId = targetGame.id;
      socket.userId = finalUserId;
      
      contactManager.addUser(finalUserId, user.name, socket.id);
      
      socket.emit('game-joined', {
        game: targetGame.getPlayerView(finalUserId),
        gameType: targetGame.settings.type
      });
      
      socket.to(targetGame.id).emit('player-joined', {
        game: targetGame.getPublicState(),
        newPlayer: { name: user.name, avatar: user.avatar }
      });
      
    } catch (error) {
      console.error('Error in join-by-url:', error);
      serverStats.errors++;
      socket.emit('error', { message: error.message || 'Failed to join game' });
    }
  });

  // Start game
  socket.on('start-game', async (data) => {
    try {
      const { settings } = data;
      const game = gameManager.getGame(socket.gameId);
      
      if (!game) throw new Error('Game not found');
      if (game.hostId !== socket.userId) throw new Error('Only the host can start the game');

      const connectedPlayers = game.players.filter(p => p.connected !== false);
      if (connectedPlayers.length < 2) {
        throw new Error(`Need at least 2 connected players to start`);
      }

      game.players = connectedPlayers;
      await game.startGame(settings);
      
      sendGameUpdateToAll(game.id, 'game-started');

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  // Game actions
  socket.on('skip-turn', async () => {
    try {
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.skipPlayerTurn(socket.userId);
      sendGameUpdateToAll(socket.gameId, 'turn-skipped', {
        playerId: socket.userId,
        playerName: game.players.find(p => p.id === socket.userId)?.name,
        result
      });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('trade-request', async (data) => {
    try {
      const { targetPlayerId } = data;
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.requestTrade(socket.userId, targetPlayerId);
      sendGameUpdateToAll(socket.gameId, 'trade-completed', { result });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('flip-card', async () => {
    try {
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      await game.flipPlayerCard(socket.userId);
      sendGameUpdateToAll(socket.gameId, 'card-flipped', {
        playerId: socket.userId,
        playerName: game.players.find(p => p.id === socket.userId)?.name
      });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('dealer-trade-deck', async () => {
    try {
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.dealerTradeWithDeck(socket.userId);
      sendGameUpdateToAll(socket.gameId, 'dealer-traded-deck', { result });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('dealer-skip-trade', async () => {
    try {
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.skipDealerTrade(socket.userId);
      sendGameUpdateToAll(socket.gameId, 'dealer-skipped-trade', { result });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('trade-with-deck-special', async (data) => {
    try {
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.dealerKingDeckTrade(socket.userId);
      sendGameUpdateToAll(socket.gameId, 'trade-completed', { result });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  }); 

  socket.on('end-round', async () => {
    try {
      const game = gameManager.getGame(socket.gameId);
      if (!game) throw new Error('Game not found');

      const roundResult = await game.endRound();
      sendGameUpdateToAll(socket.gameId, 'round-ended', { result: roundResult });

      if (game.isFinished()) {
        io.to(socket.gameId).emit('game-finished', {
          winner: game.getWinner(),
          finalStats: game.getFinalStats()
        });
      }

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  // Spectator features
  socket.on('join-as-spectator', async (data) => {
    try {
      const { userId, name } = data;
      const game = gameManager.getGame(socket.gameId);
      
      if (!game) throw new Error('Game not found');

      await game.addSpectator({
        id: userId || `spectator_${socket.id}`,
        socketId: socket.id,
        name: name || `Spectator_${socket.id.substr(-4)}`
      });

      socket.join(socket.gameId);
      socket.isSpectator = true;

      io.to(socket.gameId).emit('spectator-joined', {
        spectator: { id: userId, name: name }
      });

    } catch (error) {
      serverStats.errors++;
      socket.emit('error', { message: error.message });
    }
  });

  // Chat messages
  socket.on('game-chat', (data) => {
    const { message } = data;
    const game = gameManager.getGame(socket.gameId);
    const player = game?.players.find(p => p.id === socket.userId);
    
    io.to(socket.gameId).emit('chat-message', {
      playerId: socket.userId,
      playerName: player?.name || 'Unknown',
      message: message.substring(0, 200),
      timestamp: Date.now(),
      isSpectator: socket.isSpectator || false
    });
  });

  // Disconnect handling
  socket.on('disconnect', (reason) => {
    serverStats.activeConnections--;
    console.log(`User disconnected: ${socket.id} (${reason}) (Active: ${serverStats.activeConnections})`);

    if (socket.userId) {
      // For mobile disconnections, don't immediately remove from contacts
      if (reason !== 'transport close') {
        contactManager.removeUser(socket.userId);
      }
    }

    if (socket.gameId) {
      const game = gameManager.getGame(socket.gameId);
      if (game) {
        if (socket.isSpectator) {
          game.removeSpectator(socket.userId);
        } else {
          // IMPROVED: Handle mobile disconnections gracefully
          if (reason === 'transport close') {
            // Mobile disconnect - mark as temporarily disconnected
            const player = game.players.find(p => p.id === socket.userId);
            if (player) {
              player.connected = false;
              player.disconnectedAt = Date.now();
              console.log(`📱 Mobile player ${player.name} temporarily disconnected`);
            }
          } else {
            // Normal disconnect - handle as before
            game.handlePlayerDisconnect(socket.userId);
          }
        }

        io.to(socket.gameId).emit('player-disconnected', {
          playerId: socket.userId,
          isSpectator: socket.isSpectator || false,
          isTemporary: reason === 'transport close'
        });

        if (game.settings.isPublic) {
          gameManager.updatePublicGame(game.id);
        }
      }
    }
  });

// Initialize managers
gameManager = new GameManager();
contactManager = new ContactManager();

// Error handling
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  serverStats.errors++;
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Production monitoring
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(`Stats - Games: ${gameManager.getActiveGameCount()}, Players: ${gameManager.getConnectedPlayerCount()}, Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
}, 60000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 Screw Your Neighbor server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Production mode: ${process.env.NODE_ENV === 'production'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  if (gameManager.gameCleanupInterval) {
    clearInterval(gameManager.gameCleanupInterval);
  }
  if (contactManager.cleanupInterval) {
    clearInterval(contactManager.cleanupInterval);
  }
  
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  serverStats.errors++;
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  serverStats.errors++;
});

module.exports = { app, server, io, gameManager, contactManager };