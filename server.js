// server.js - Complete Backend with Fixed Card Visibility + Modern Game Joining
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
// Serve static files
app.use(express.static('.'));

// Serve the game at root path
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// NEW: Direct URL joining route
app.get('/join/:friendCode', (req, res) => {
    const friendCode = req.params.friendCode;
    res.redirect(`/?join=${friendCode}`);
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Mobile-optimized settings:
  pingTimeout: 60000,      // 60 seconds (mobile networks are slow)
  pingInterval: 25000,     // 25 seconds (check connection)
  upgradeTimeout: 30000,   // 30 seconds for mobile upgrades
  allowEIO3: true          // Backwards compatibility
});

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Game managers will be initialized after class definitions
let gameManager;
let contactManager;

// Simple contact system
class ContactManager {
  constructor() {
    this.friendCodes = new Map(); // friendCode -> userId
    this.userFriends = new Map(); // userId -> Set of friend userIds
    this.onlineUsers = new Map(); // userId -> { name, socketId }
  }

  addUser(userId, name, socketId) {
    this.onlineUsers.set(userId, { name, socketId });
  }

  removeUser(userId) {
    this.onlineUsers.delete(userId);
  }

  generateFriendCode(userId) {
    const code = 'FC' + userId.slice(-6).toUpperCase();
    this.friendCodes.set(code, userId);
    console.log(`Generated friend code ${code} for user ${userId}`);
    return code;
  }

  addFriendByCode(userId, friendCode, userName) {
    console.log(`Attempting to add friend: ${userId} -> ${friendCode}`);
    console.log(`Available friend codes:`, Array.from(this.friendCodes.keys()));
    
    const friendId = this.friendCodes.get(friendCode);
    if (!friendId) {
      throw new Error(`Friend code ${friendCode} not found`);
    }

    if (friendId === userId) {
      throw new Error('Cannot add yourself as friend');
    }

    // Add bidirectional friendship
    if (!this.userFriends.has(userId)) {
      this.userFriends.set(userId, new Set());
    }
    if (!this.userFriends.has(friendId)) {
      this.userFriends.set(friendId, new Set());
    }

    this.userFriends.get(userId).add(friendId);
    this.userFriends.get(friendId).add(userId);

    console.log(`Successfully added friendship: ${userId} <-> ${friendId}`);
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeGames: gameManager ? gameManager.getActiveGameCount() : 0
  });
});

// Simple auth validation for demo
const validateUserToken = async (token, providedName = null) => {
  // In production, this would validate JWT tokens
  if (token && token.startsWith('demo_token_')) {
    const userId = token.replace('demo_token_', '');
    return {
      id: userId,
      name: providedName || ('Player_' + userId.slice(-4)), // Use provided name or fallback
      avatar: 'default'
    };
  }
  return null;
};

// Helper function to send personalized game updates
function sendGameUpdateToAll(gameId, eventName, data = {}) {
  const game = gameManager.getGame(gameId);
  if (!game) return;
  
  game.players.forEach(player => {
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit(eventName, {
        ...data,
        game: game.getPlayerView(player.id)
      });
    }
  });
  
  // Send public view to spectators
  game.spectators.forEach(spectator => {
    if (spectator.socketId) {
      io.to(spectator.socketId).emit(eventName, {
        ...data,
        game: game.getPublicState()
      });
    }
  });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('heartbeat', (data) => {
    socket.emit('heartbeat-ack', { timestamp: Date.now() });
});

  // Generate friend code for new connections
  socket.on('get-friend-code', (data) => {
    const { userId, userName } = data;
    
    // Add user to contact manager
    contactManager.addUser(userId, userName, socket.id);
    const friendCode = contactManager.generateFriendCode(userId);
    
    socket.emit('friend-code-generated', { friendCode });
  });

  // Create game
  socket.on('create-game', async (data) => {
    const { gameId, userId, token, settings, playerName } = data;
    
    try {
      // Validate user token with provided name
      const user = await validateUserToken(token, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      // Create game with settings
      const game = gameManager.createGame(gameId, userId, settings);
      
      // Add to public games if public
      if (settings.isPublic) {
        gameManager.addPublicGame(game, user.name);
      }

      // Add creator as first player
      await game.addPlayer({
        id: userId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });

      socket.join(gameId);
      socket.gameId = gameId;
      socket.userId = userId;

      // Add user to contact manager
      contactManager.addUser(userId, user.name, socket.id);
      const friendCode = contactManager.generateFriendCode(userId);

      socket.emit('game-created', {
        game: game.getPublicState(),
        friendCode: friendCode
      });

      // Broadcast to public games if public
      if (settings.isPublic) {
        socket.broadcast.emit('public-games-updated');
      }

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // FIXED: Join game room (removed the broken closing bracket)
  socket.on('join-game', async (data) => {
    console.log('Join game request received:', data);
    const { gameId, userId, token, playerName, friendCode } = data;
    
    try {
      // Validate user token with provided name
      const user = await validateUserToken(token, playerName);
      if (!user) {
        console.log('Invalid token for user:', userId);
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      console.log('User validated:', user);

      // Find game by gameId or friendCode
      let game = null;
      if (gameId) {
        game = gameManager.getGame(gameId);
      } else if (friendCode) {
        // Search for game by friend code
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
        console.log('Game not found:', gameId || friendCode);
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      console.log('Game found:', game.id, 'Players:', game.players.length);

      // Check if game is full
      if (game.players.length >= game.maxPlayers) {
        socket.emit('error', { message: 'Game is full' });
        return;
      }

      // Check if game has already started
      if (game.hasStarted()) {
        socket.emit('error', { message: 'Game has already started' });
        return;
      }

      // Check game access permissions
      if (game.settings.type === 'private' && game.settings.password) {
        if (data.password !== game.settings.password) {
          socket.emit('error', { message: 'Incorrect password' });
          return;
        }
      } else if (game.settings.type === 'friends') {
        const friends = contactManager.getFriends(game.hostId);
        const isFriend = friends.some(f => f.id === userId);
        if (!isFriend && userId !== game.hostId) {
          socket.emit('error', { message: 'This is a friends-only game' });
          return;
        }
      }

      // Join game
      const addedPlayer = await game.addPlayer({
        id: userId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });

      console.log('Player added to game:', addedPlayer.name);

      socket.join(game.id);
      socket.gameId = game.id;
      socket.userId = userId;

      // Add user to contact manager
      contactManager.addUser(userId, user.name, socket.id);

      // Emit success to joining player
      socket.emit('game-joined', {
        game: game.getPlayerView(userId),
        rejoin: false
      });

      // Notify other players in the game
      socket.to(game.id).emit('player-joined', {
        game: game.getPublicState(),
        newPlayer: {
          name: user.name,
          avatar: user.avatar
        }
      });

      console.log('Player joined event sent to game room');

      // Update public games list if this is a public game
      if (game.settings.isPublic) {
        gameManager.updatePublicGame(game.id);
        io.emit('public-games-updated');
      }

    } catch (error) {
      console.log('Join game error:', error.message);
      socket.emit('error', { message: error.message });
    }
  });

  // NEW: Quick Match Handler
  socket.on('quick-match', async (data) => {
    console.log('Quick match request from', data.playerName);
    const { userId, token, playerName } = data;
    
    try {
      // Validate user token
      const user = await validateUserToken(token, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      // Find an existing public game with space
      const publicGames = gameManager.getPublicGames();
      let availableGame = null;
      
      for (let publicGameInfo of publicGames) {
        const game = gameManager.getGame(publicGameInfo.id);
        if (game && !game.hasStarted() && game.players.length < game.maxPlayers) {
          availableGame = game;
          break;
        }
      }
      
      if (availableGame) {
        // Join existing public game
        const addedPlayer = await availableGame.addPlayer({
          id: userId,
          socketId: socket.id,
          name: user.name,
          avatar: user.avatar
        });
        
        socket.join(availableGame.id);
        socket.gameId = availableGame.id;
        socket.userId = userId;
        
        // Add user to contact manager
        contactManager.addUser(userId, user.name, socket.id);
        
        socket.emit('game-joined', {
          game: availableGame.getPlayerView(userId),
          gameType: 'public'
        });
        
        // Notify other players
        socket.to(availableGame.id).emit('player-joined', {
          game: availableGame.getPublicState(),
          newPlayer: {
            name: user.name,
            avatar: user.avatar
          }
        });
        
        // Update public games list
        gameManager.updatePublicGame(availableGame.id);
        socket.broadcast.emit('public-games-updated');
        
        console.log(`Player ${user.name} joined existing public game ${availableGame.id}`);
      } else {
        // Create new public game
        const gameId = uuidv4();
        
        const game = gameManager.createGame(gameId, userId, {           
          isPublic: true,           
          type: 'public',           
          maxPlayers: 30  // ← Changed from 4 to 30
        });
        
        // Add to public games
        gameManager.addPublicGame(game, user.name);
        
        // Add creator as first player
        await game.addPlayer({
          id: userId,
          socketId: socket.id,
          name: user.name,
          avatar: user.avatar
        });
        
        socket.join(gameId);
        socket.gameId = gameId;
        socket.userId = userId;
        
        // Add user to contact manager
        contactManager.addUser(userId, user.name, socket.id);
        const friendCode = contactManager.generateFriendCode(userId);
        
        socket.emit('public-game-created', {
          game: game.getPlayerView(userId),
          friendCode: friendCode,
          gameType: 'public'
        });
        
        // Broadcast to update public games list
        socket.broadcast.emit('public-games-updated');
        
        console.log(`New public game created: ${gameId} by ${user.name}`);
      }
      
    } catch (error) {
      console.error('Error in quick-match:', error);
      socket.emit('error', { message: error.message || 'Failed to find/create game' });
    }
  });

  // NEW: Create Private Game Handler
  socket.on('create-private-game', async (data) => {
    const { userId, token, playerName, settings = {} } = data;
    
    try {
      // Validate user token
      const user = await validateUserToken(token, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      // Create private game
      const gameId = uuidv4();
      
      const game = gameManager.createGame(gameId, userId, {
        ...settings,
        isPublic: false,
        type: 'private',
        maxPlayers: settings.maxPlayers || 8  // ← Use custom or default to 8
      });
      
      // Add creator as first player
      await game.addPlayer({
        id: userId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });

      socket.join(gameId);
      socket.gameId = gameId;
      socket.userId = userId;

      // Add user to contact manager
      contactManager.addUser(userId, user.name, socket.id);
      const friendCode = contactManager.generateFriendCode(userId);
      
      // Create shareable link
      const baseUrl = process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3001}`;
      const shareableLink = `${baseUrl}/join/${friendCode}`;
      
      socket.emit('private-game-created', {
        game: game.getPlayerView(userId),
        friendCode: friendCode,
        shareableLink: shareableLink,
        gameType: 'private'
      });
      
      console.log(`Private game created: ${gameId} by ${user.name}`);
      
    } catch (error) {
      console.error('Error creating private game:', error);
      socket.emit('error', { message: error.message || 'Failed to create private game' });
    }
  });

  // NEW: Join by URL Handler
  socket.on('join-by-url', async (data) => {
    const { friendCode, userId, token, playerName } = data;
    
    try {
      // Validate user token
      const user = await validateUserToken(token, playerName);
      if (!user) {
        socket.emit('error', { message: 'Invalid authentication' });
        return;
      }

      // Find game by friend code
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
      
      // Add player to game
      const addedPlayer = await targetGame.addPlayer({
        id: userId,
        socketId: socket.id,
        name: user.name,
        avatar: user.avatar
      });
      
      socket.join(targetGame.id);
      socket.gameId = targetGame.id;
      socket.userId = userId;
      
      // Add user to contact manager
      contactManager.addUser(userId, user.name, socket.id);
      
      socket.emit('game-joined', {
        game: targetGame.getPlayerView(userId),
        gameType: targetGame.settings.type
      });
      
      socket.join(targetGame.id);

      // Notify other players
      socket.to(targetGame.id).emit('player-joined', {
        game: targetGame.getPublicState(),
        newPlayer: {
          name: user.name,
          avatar: user.avatar
        }
      });
      
      console.log(`Player ${user.name} joined game via URL: ${targetGame.id}`);
      
    } catch (error) {
      console.error('Error in join-by-url:', error);
      socket.emit('error', { message: error.message || 'Failed to join game' });
    }
  });

  // Start game
  // In your server.js, find the 'start-game' socket handler and update it:

socket.on('start-game', async (data) => {
    const { gameId, settings } = data;
    
    try {
        const game = gameManager.getGame(gameId);
        if (!game) throw new Error('Game not found');
        
        if (game.hostId !== socket.userId) {
            throw new Error('Only the host can start the game');
        }

        // FIXED: Count only connected players
        const connectedPlayers = game.players.filter(p => p.connected !== false);
        if (connectedPlayers.length < 2) {
            throw new Error(`Need at least 2 connected players to start (${connectedPlayers.length} connected, ${game.players.length} total)`);
        }

        // Optional: Remove disconnected players before starting
        game.players = game.players.filter(p => p.connected !== false);
        
        await game.startGame(settings);
        
        sendGameUpdateToAll(gameId, 'game-started');

    } catch (error) {
        socket.emit('error', { message: error.message });
    }
});

  // Skip turn (for any card)
  socket.on('skip-turn', async (data) => {
    const { gameId } = data;
    
    try {
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.skipPlayerTurn(socket.userId);
      
      sendGameUpdateToAll(gameId, 'turn-skipped', {
        playerId: socket.userId,
        result
      });

    } catch (error) {
      console.log('Skip turn error:', error.message);
      socket.emit('error', { message: error.message });
    }
  });

  // Trade card request
  socket.on('trade-request', async (data) => {
    const { gameId, targetPlayerId, direction } = data;
    
    try {
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.requestTrade(socket.userId, targetPlayerId, direction);
      
      sendGameUpdateToAll(gameId, 'trade-completed', {
        result
      });

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Dealer trade with deck
  socket.on('dealer-trade-deck', async (data) => {
    const { gameId } = data;
    
    try {
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.dealerTradeWithDeck(socket.userId);
      
      sendGameUpdateToAll(gameId, 'dealer-traded-deck', {
        result
      });

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Dealer skip trade
  socket.on('dealer-skip-trade', async (data) => {
    const { gameId } = data;
    
    try {
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.skipDealerTrade(socket.userId);
      
      sendGameUpdateToAll(gameId, 'dealer-skipped-trade', {
        result
      });

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Flip card
  socket.on('flip-card', async (data) => {
    const { gameId } = data;
    
    try {
      console.log(`Flip card request from ${socket.userId} in game ${gameId}`);
      
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      const result = await game.flipPlayerCard(socket.userId);
      
      console.log(`Card flipped successfully for ${socket.userId}`);
      
      sendGameUpdateToAll(gameId, 'card-flipped', {
        playerId: socket.userId
      });

    } catch (error) {
      console.log('Flip card error:', error.message);
      socket.emit('error', { message: error.message });
    }
  });

  // End round (reveal all cards)
  socket.on('end-round', async (data) => {
    const { gameId } = data;
    
    try {
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      const roundResult = await game.endRound();
      
      sendGameUpdateToAll(gameId, 'round-ended', {
        result: roundResult
      });

      // Check if game is finished
      if (game.isFinished()) {
        io.to(gameId).emit('game-finished', {
          winner: game.getWinner(),
          finalStats: game.getFinalStats()
        });
      }

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Spectator features
  socket.on('join-as-spectator', async (data) => {
    const { gameId, userId } = data;
    
    try {
      const game = gameManager.getGame(gameId);
      if (!game) throw new Error('Game not found');

      await game.addSpectator({
        id: userId,
        socketId: socket.id,
        name: data.name
      });

      socket.join(gameId);
      socket.gameId = gameId;
      socket.isSpectator = true;

      io.to(gameId).emit('spectator-joined', {
        spectator: { id: userId, name: data.name }
      });

    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Chat messages
  socket.on('game-chat', (data) => {
    const { gameId, message } = data;
    
    io.to(gameId).emit('chat-message', {
      playerId: socket.userId,
      message,
      timestamp: Date.now(),
      isSpectator: socket.isSpectator || false
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove from contact manager
    if (socket.userId) {
      contactManager.removeUser(socket.userId);
    }
    
    if (socket.gameId) {
      const game = gameManager.getGame(socket.gameId);
      if (game) {
        if (socket.isSpectator) {
          game.removeSpectator(socket.userId);
        } else {
          game.handlePlayerDisconnect(socket.userId);
        }
        
        io.to(socket.gameId).emit('player-disconnected', {
          playerId: socket.userId,
          isSpectator: socket.isSpectator || false
        });

        // Update public games if this was a public game
        if (game.settings.isPublic) {
          gameManager.updatePublicGame(game.id);
          io.emit('public-games-updated');
        }
      }
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// =============================================================================
// GAME LOGIC CLASSES
// =============================================================================

class GameManager {
  constructor() {
    this.games = new Map();
    this.playerGameMap = new Map(); // Track which game each player is in
    this.publicGames = new Map(); // Track public games for lobby
  }

  createGame(gameId, hostId, settings = {}) {
    const game = new Game(gameId, hostId, settings);
    this.games.set(gameId, game);
    this.playerGameMap.set(hostId, gameId);
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
      settings: game.settings
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
      .slice(0, 20); // Limit to 20 games
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
      // Remove all players from the map
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

  getPlayerGame(playerId) {
    const gameId = this.playerGameMap.get(playerId);
    return gameId ? this.games.get(gameId) : null;
  }
}

class Game {
  constructor(id, hostId, settings = {}) {
    this.id = id;
    this.hostId = hostId;
    this.players = [];
    this.spectators = [];
    this.dealerIndex = 0; // Track dealer position
    this.currentPlayerIndex = 1; // First player after dealer starts
    this.round = 1;
    this.maxPlayers = settings.maxPlayers || 8;
    this.state = 'waiting'; // waiting, playing, finished
    this.turnPhase = 'trading'; // trading, revealing, finished
    this.deck = [];
    this.playersWhoActed = new Set(); // Track who has had their turn
    this.settings = {
      startingLives: settings.startingLives || 3,
      deckCount: settings.deckCount || 1,
      tournamentMode: settings.tournamentMode || 'single',
      cardStyle: settings.cardStyle || 'classic',
      allowSpectatorBetting: settings.allowSpectatorBetting || true,
      type: settings.type || 'public', // public, private, friends
      password: settings.password || null,
      isPublic: settings.isPublic || false,
      ...settings
    };
    this.roundHistory = [];
    this.spectatorBets = [];
  }

  async addPlayer(player) {
    if (this.isFull()) throw new Error('Game is full');
    if (this.hasStarted()) throw new Error('Game already started');

    // Check if player is already in the game
    const existingPlayer = this.players.find(p => p.id === player.id);
    if (existingPlayer) {
      // Update existing player's socket info instead of adding duplicate
      existingPlayer.socketId = player.socketId;
      existingPlayer.connected = true;
      existingPlayer.name = player.name;
      existingPlayer.avatar = player.avatar;
      return existingPlayer;
    }

    const newPlayer = {
      ...player,
      lives: this.settings.startingLives,
      card: null,
      cardRevealed: false,
      hasTraded: false,
      connected: true,
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
    this.spectators.push(spectator);
  }

  removeSpectator(spectatorId) {
    this.spectators = this.spectators.filter(s => s.id !== spectatorId);
  }

  async startGame(customSettings = {}) {
    if (this.players.length < 2) throw new Error('Need at least 2 players');
    
    // Update settings if provided
    this.settings = { ...this.settings, ...customSettings };
    
    this.initializeDeck();
    this.shuffleDeck();
    this.dealCards();
    this.state = 'playing';
    this.dealerIndex = 0; // Track dealer position
    this.currentPlayerIndex = 1; // First player after dealer starts
    this.turnPhase = 'trading'; // trading, revealing, finished
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
    
    // Check if enough cards remain, if not reshuffle
    if (this.deck.length < activePlayers.length) {
      console.log(`Not enough cards (${this.deck.length}) for ${activePlayers.length} players. Reshuffling...`);
      this.initializeDeck();
      this.shuffleDeck();
    }

    activePlayers.forEach(player => {
      player.card = this.deck.pop();
      player.cardRevealed = false;
      player.hasTraded = false;
    });

    // Reset turn tracking
    this.playersWhoActed.clear();
    this.turnPhase = 'trading';
  }

  advanceToNextPlayer() {
    const activePlayers = this.players.filter(p => p.lives > 0);
    
    // Move to next player
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % activePlayers.length;
    
    // Check if we've come back to the dealer (last player to act)
    if (this.currentPlayerIndex === this.dealerIndex) {
      this.turnPhase = 'dealer-turn';
    }
    
    // Check if all non-dealer players have acted
    const nonDealerCount = activePlayers.length - 1;
    if (this.playersWhoActed.size >= nonDealerCount) {
      this.turnPhase = 'dealer-turn';
    }
  }

  async requestTrade(fromPlayerId, toPlayerId, direction) {
    const fromPlayer = this.players.find(p => p.id === fromPlayerId);
    const toPlayer = this.players.find(p => p.id === toPlayerId);
    
    if (!fromPlayer || !toPlayer) throw new Error('Player not found');
    if (this.turnPhase !== 'trading') throw new Error('Not in trading phase');
    
    // Check if it's the player's turn
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    if (fromPlayer.id !== currentPlayer.id) {
      throw new Error('Not your turn to trade');
    }
    
    // Check if player has already acted this turn
    if (this.playersWhoActed.has(fromPlayerId)) {
      throw new Error('You have already acted this turn');
    }
    
    // In Screw Your Neighbor, you trade with the next player (clockwise)
    const fromIndex = activePlayers.findIndex(p => p.id === fromPlayerId);
    const nextIndex = (fromIndex + 1) % activePlayers.length;
    const nextPlayer = activePlayers[nextIndex];
    
    if (nextPlayer.id !== toPlayerId) {
      throw new Error('You can only trade with the next player');
    }
    
    // Check what the target player has
    const hasJack = toPlayer.card && toPlayer.card.value === 'J';
    const hasKing = toPlayer.card && toPlayer.card.value === 'K';
    
    // SPECIAL CASE: Trading with dealer who has King = trade with deck instead!
    const isDealerTarget = toPlayer.id === activePlayers[this.dealerIndex].id;
    const isLastPlayerBeforeDealer = (fromIndex + 1) % activePlayers.length === this.dealerIndex;
    
    let traded = false;
    let blocked = false;
    let kingRevealed = false;
    let tradedWithDeck = false;
    let deckCard = null;
    
    if (hasJack) {
      // Jack blocks the trade - "Screw You!"
      blocked = true;
      toPlayer.cardRevealed = true; // Reveal the Jack
      fromPlayer.stats.tradesBlocked++;
    } else if (hasKing && isDealerTarget) {
      // SPECIAL RULE: Player before dealer with King gets to trade with deck!
      if (this.deck.length === 0) {
        throw new Error('No cards left in deck');
      }
      
      deckCard = this.deck.pop();
      const playerCard = fromPlayer.card;
      fromPlayer.card = deckCard;
      
      // Discard player's old card (not put back in deck)
      // Card is simply discarded - no need to track it
      
      tradedWithDeck = true;
      kingRevealed = true;
      toPlayer.cardRevealed = true; // Reveal the dealer's King
      fromPlayer.cardRevealed = true; // Auto-reveal the new deck card
      fromPlayer.stats.tradesInitiated++;
    } else if (hasKing) {
      // King pass-through logic
      kingRevealed = true;
      toPlayer.cardRevealed = true; // Reveal the King
  
      // Find next player after the King holder
      const kingHolderIndex = activePlayers.findIndex(p => p.id === toPlayer.id);
      let nextPlayerIndex = (kingHolderIndex + 1) % activePlayers.length;
      let nextPlayer = activePlayers[nextPlayerIndex];
  
      // Keep looking for next non-King player
      while (nextPlayer.card && nextPlayer.card.value === 'K' && nextPlayerIndex !== fromPlayer.id) {
        nextPlayer.cardRevealed = true; // Reveal subsequent Kings
        nextPlayerIndex = (nextPlayerIndex + 1) % activePlayers.length;
        nextPlayer = activePlayers[nextPlayerIndex];
      }
  
      // Special case: If we end up at the dealer, trade with deck
      if (nextPlayerIndex === this.dealerIndex) {
        if (this.deck.length === 0) {
          throw new Error('No cards left in deck for dealer trade');
        }
    
        const deckCard = this.deck.pop();
        const playerCard = fromPlayer.card;
        fromPlayer.card = deckCard;
        fromPlayer.cardRevealed = true; // Auto-reveal deck card
    
        tradedWithDeck = true;
        fromPlayer.stats.tradesInitiated++;
      } else if (nextPlayer.card && nextPlayer.card.value === 'J') {
        // Next player has Jack - blocks the pass-through
        nextPlayer.cardRevealed = true; // Reveal the blocking Jack
        blocked = true;
        fromPlayer.stats.tradesBlocked++;
      } else {
        // Normal trade with the next available player
        const tempCard = fromPlayer.card;
        fromPlayer.card = nextPlayer.card;
        nextPlayer.card = tempCard;
        traded = true;
        fromPlayer.cardRevealed = true; // Auto-reveal new card
        fromPlayer.stats.tradesInitiated++;
      }
  
      // Mark player as having acted
      this.playersWhoActed.add(fromPlayerId);
      this.advanceToNextPlayer();

    } else {
      // Normal trade - swap cards
      const tempCard = fromPlayer.card;
      fromPlayer.card = toPlayer.card;
      toPlayer.card = tempCard;
      traded = true;
      fromPlayer.stats.tradesInitiated++;
      
      // Auto-reveal the new card for the player who initiated the trade
      fromPlayer.cardRevealed = true;
    }
    
    // Mark player as having acted (unless King allows passing)
    if (!kingRevealed) {
      this.playersWhoActed.add(fromPlayerId);
      this.advanceToNextPlayer();
    }
    
    return { 
      traded, 
      blocked, 
      kingRevealed,
      tradedWithDeck,
      deckCard,
      roundEnded: this.turnPhase === 'revealing', // Indicate if round ended
      fromPlayer, 
      toPlayer 
    };
  }

  async skipPlayerTurn(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');
    
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    if (player.id !== currentPlayer.id) {
      throw new Error('Not your turn');
    }
    
    // Players can keep ANY card
    const isKing = player.card && player.card.value === 'K';
    
    // Mark player as having acted
    this.playersWhoActed.add(playerId);
    
    // ONLY reveal Kings automatically when kept (for protection)
    // Other cards stay hidden when kept
    if (isKing) {
      player.cardRevealed = true;
      console.log(`Player ${playerId} kept King - auto-revealed for protection`);
    } else {
      console.log(`Player ${playerId} kept their ${player.card.value} - card stays hidden`);
    }
    
    // Move to next player's turn
    this.advanceToNextPlayer();
    
    return { skipped: true, keptCard: true, wasKing: isKing };
  }

  async dealerTradeWithDeck(dealerId) {
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

    // Dealer trades with top card of deck
    const deckCard = this.deck.pop();
    const dealerCard = dealer.card;
    dealer.card = deckCard;
    
    // Auto-reveal the new card for dealer
    dealer.cardRevealed = true;

    // Discard dealer's old card (not put back in deck)
    // Card is simply discarded - no need to track it

    // Move to revealing phase
    this.turnPhase = 'revealing';
    
    return { traded: true, newCard: deckCard, oldCard: dealerCard };
  }

  async skipDealerTrade(dealerId) {
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

    // Move to revealing phase
    this.turnPhase = 'revealing';
    
    return { skipped: true };
  }

  async flipPlayerCard(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error('Player not found');
    
    // Players can flip their card any time to see what they have
    player.cardRevealed = true;
    console.log(`Player ${playerId} flipped their card: ${player.card.value} of ${player.card.suit}`);
    return player;
  }

  async endRound() {
    const activePlayers = this.players.filter(p => p.lives > 0);
    
    // Can only end round in revealing phase
    if (this.turnPhase !== 'revealing') {
      throw new Error('Cannot end round yet - still in trading phase');
    }
    
    // Reveal all cards
    activePlayers.forEach(player => {
      player.cardRevealed = true;
    });

    // Find the lowest card(s) - ALL players with lowest value lose a life
    const lowestValue = Math.min(...activePlayers.map(p => p.card.numValue));
    const losers = activePlayers.filter(p => p.card.numValue === lowestValue);

    console.log(`Round ${this.round}: Lowest value is ${lowestValue}, ${losers.length} player(s) lose a life`);
    console.log(`Losers: ${losers.map(p => `${p.name} (${p.card.value})`).join(', ')}`);

    // Remove lives from ALL losers (handles ties correctly)
    losers.forEach(player => {
      player.lives--;
      player.stats.roundsLost++;
      console.log(`${player.name} loses a life (${player.lives} remaining)`);
    });

    // Update stats for winners
    activePlayers.filter(p => p.card.numValue > lowestValue).forEach(player => {
      player.stats.roundsWon++;
    });

    // Process spectator bets
    const spectatorResults = this.processSpectatorBets(losers);

    const roundResult = {
      round: this.round,
      losers: losers.map(p => ({ id: p.id, name: p.name, card: p.card })),
      lowestValue,
      spectatorResults
    };

    this.roundHistory.push(roundResult);
    this.round++;

    // Prepare for next round if game continues
    if (!this.isFinished()) {
      // Move dealer position to next player
      const remainingPlayers = this.players.filter(p => p.lives > 0);
      this.dealerIndex = (this.dealerIndex + 1) % remainingPlayers.length;
      this.currentPlayerIndex = (this.dealerIndex + 1) % remainingPlayers.length;
      
      this.dealCards();
      this.spectatorBets = []; // Reset bets for new round
    }

    return roundResult;
  }

  processSpectatorBets(losers) {
    return this.spectatorBets.map(bet => {
      const won = !losers.some(loser => loser.id === bet.playerId);
      return {
        spectatorId: bet.spectatorId,
        playerId: bet.playerId,
        amount: bet.amount,
        won,
        payout: won ? bet.amount * 2 : 0
      };
    });
  }

  addSpectatorBet(spectatorId, playerId, amount) {
    this.spectatorBets.push({
      spectatorId,
      playerId,
      amount,
      round: this.round
    });
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
    // Mark player as disconnected but keep in game
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.connected = false;
      player.disconnectedAt = Date.now();
    }
  }

  getPublicState() {
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    const dealer = activePlayers[this.dealerIndex];
    
    return {
      id: this.id,
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
        hasCard: !!p.card, // Always indicate if player has a card
        // Only show card if it's revealed OR in revealing phase (end of round)
        card: (p.cardRevealed || this.turnPhase === 'revealing') ? p.card : null
      })),
      spectators: this.spectators.map(s => ({
        id: s.id,
        name: s.name
      })),
      cardsRemaining: this.deck.length,
      currentPlayerIndex: this.currentPlayerIndex,
      dealerIndex: this.dealerIndex
    };
  }

  // FIXED: Card visibility method - players can only see their own cards when flipped OR all cards during revealing phase
  getPlayerView(playerId) {
    const activePlayers = this.players.filter(p => p.lives > 0);
    const currentPlayer = activePlayers[this.currentPlayerIndex];
    const dealer = activePlayers[this.dealerIndex];
    
    return {
      id: this.id,
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
        hasCard: !!p.card, // Always indicate if player has a card
        // FIXED: Show card details only when appropriate:
        // 1. Own card when revealed by player
        // 2. All cards during revealing phase (end of round)
        card: this.shouldShowCardToPlayer(p, playerId) ? p.card : null
      })),
      spectators: this.spectators.map(s => ({
        id: s.id,
        name: s.name
      })),
      cardsRemaining: this.deck.length,
      currentPlayerIndex: this.currentPlayerIndex,
      dealerIndex: this.dealerIndex
    };
  }

  // Helper method to determine if a card should be visible to a specific player
  shouldShowCardToPlayer(cardOwner, viewingPlayerId) {
    // During revealing phase, everyone sees all cards
    if (this.turnPhase === 'revealing') {
      return true;
    }
    
    // Players can always see their own cards when they've flipped them
    if (cardOwner.id === viewingPlayerId && cardOwner.cardRevealed) {
      return true;
    }
    
    // Show cards that are publicly revealed due to game mechanics
    // (Jack blocks, King reveals, dealer trades, etc.)
    if (cardOwner.cardRevealed && this.isCardPubliclyVisible(cardOwner.id)) {
      return true;
    }
    
    return false;
  }

  // Helper method to track publicly visible cards
  isCardPubliclyVisible(playerId) {
    // Cards become publicly visible when:
    // 1. Jack is revealed during a block
    // 2. King is revealed during trade attempts  
    // 3. Dealer shows card after trading with deck
    // 4. Any card specifically revealed due to game rules
    
    // For now, we'll be conservative and only show cards during revealing phase
    // and when the player themselves has flipped it
    return this.turnPhase === 'revealing';
  }
}

// Initialize game managers after class definitions
gameManager = new GameManager();
contactManager = new ContactManager();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 Screw Your Neighbor server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

// Export for testing or external use
module.exports = { app, server, io };