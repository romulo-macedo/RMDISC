import express from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const PORT = 3000;

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  text: string;
  timestamp: number;
  channelId: string;
}

interface Channel {
  id: string;
  name: string;
  voiceUsers: string[];
}

interface Room {
  code: string;
  name: string;
  clients: Set<WebSocket>;
  messages: ChatMessage[];
  channels: Channel[];
  users: Map<WebSocket, { id: string; username: string }>;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const rooms = new Map<string, Room>();

  wss.on('connection', (ws) => {
    let currentRoomCode: string | null = null;
    const userId = uuidv4();

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'JOIN') {
          const { roomCode, username } = data;
          currentRoomCode = roomCode;

          if (!rooms.has(roomCode)) {
            rooms.set(roomCode, {
              code: roomCode,
              name: `Sala ${roomCode}`,
              clients: new Set(),
              messages: [],
              channels: [{ id: 'geral', name: 'geral', voiceUsers: [] }],
              users: new Map()
            });
          }

          const room = rooms.get(roomCode)!;
          room.clients.add(ws);
          room.users.set(ws, { id: userId, username });

          ws.send(JSON.stringify({
            type: 'ROOM_STATE',
            payload: {
              myUserId: userId,
              roomCode,
              messages: room.messages,
              channels: room.channels,
              users: Array.from(room.users.values())
            }
          }));

          const joinMsg = {
            id: uuidv4(),
            userId: 'SYSTEM',
            username: 'Sistema',
            text: `${username} entrou na sala.`,
            timestamp: Date.now(),
            channelId: 'geral'
          };
          room.messages.push(joinMsg);

          broadcastToRoom(roomCode, {
            type: 'USER_JOINED',
            payload: {
              user: { id: userId, username },
              systemMessage: joinMsg,
              users: Array.from(room.users.values())
            }
          });
        } 
        else if (data.type === 'MESSAGE' && currentRoomCode) {
          const room = rooms.get(currentRoomCode);
          if (room && room.users.has(ws)) {
            const user = room.users.get(ws)!;
            const chatMsg: ChatMessage = {
              id: uuidv4(),
              userId: user.id,
              username: user.username,
              text: data.text,
              timestamp: Date.now(),
              channelId: data.channelId || 'geral'
            };
            room.messages.push(chatMsg);
            
            if (room.messages.length > 500) room.messages.shift();

            broadcastToRoom(currentRoomCode, {
              type: 'NEW_MESSAGE',
              payload: chatMsg
            });
          }
        }
        else if (data.type === 'CREATE_CHANNEL' && currentRoomCode) {
          const room = rooms.get(currentRoomCode);
          if (room) {
            const newChannel: Channel = { id: uuidv4(), name: data.channelName, voiceUsers: [] };
            room.channels.push(newChannel);
            broadcastToRoom(currentRoomCode, {
              type: 'CHANNEL_CREATED',
              payload: newChannel
            });
          }
        }
        else if (data.type === 'JOIN_VOICE' && currentRoomCode) {
          const room = rooms.get(currentRoomCode);
          if (room) {
            room.channels.forEach(c => {
               if (c.voiceUsers.includes(userId)) {
                   c.voiceUsers = c.voiceUsers.filter(id => id !== userId);
                   broadcastToRoom(currentRoomCode!, {
                     type: 'USER_LEFT_VOICE', 
                     payload: { userId, channelId: c.id }
                   });
               }
            });
            const channel = room.channels.find(c => c.id === data.channelId);
            if (channel) {
               channel.voiceUsers.push(userId);
               broadcastToRoom(currentRoomCode, {
                 type: 'VOICE_STATE_UPDATED',
                 payload: room.channels
               });
               broadcastToRoom(currentRoomCode, {
                 type: 'USER_JOINED_VOICE',
                 payload: { userId, channelId: channel.id }
               });
            }
          }
        }
        else if (data.type === 'LEAVE_VOICE' && currentRoomCode) {
          const room = rooms.get(currentRoomCode);
          if (room) {
            room.channels.forEach(c => {
               if (c.voiceUsers.includes(userId)) {
                   c.voiceUsers = c.voiceUsers.filter(id => id !== userId);
                   broadcastToRoom(currentRoomCode!, {
                     type: 'USER_LEFT_VOICE', 
                     payload: { userId, channelId: c.id }
                   });
               }
            });
            broadcastToRoom(currentRoomCode, {
              type: 'VOICE_STATE_UPDATED',
              payload: room.channels
            });
          }
        }
        else if (['WEBRTC_OFFER', 'WEBRTC_ANSWER', 'WEBRTC_ICE_CANDIDATE'].includes(data.type)) {
          const room = rooms.get(currentRoomCode!);
          if (room) {
            let targetWs: WebSocket | null = null;
            for (const [clientWs, clientUser] of room.users.entries()) {
              if (clientUser.id === data.targetUserId) {
                targetWs = clientWs;
                break;
              }
            }
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                ...data,
                senderId: userId
              }));
            }
          }
        }
      } catch (e) {
        console.error('Error processing message', e);
      }
    });

    ws.on('close', () => {
      if (currentRoomCode && rooms.has(currentRoomCode)) {
        const room = rooms.get(currentRoomCode)!;
        const user = room.users.get(ws);
        
        room.clients.delete(ws);
        room.users.delete(ws);

        if (user) {
          const leaveMsg = {
            id: uuidv4(),
            userId: 'SYSTEM',
            username: 'Sistema',
            text: `${user.username} saiu da sala.`,
            timestamp: Date.now(),
            channelId: 'geral'
          };
          room.messages.push(leaveMsg);

          room.channels.forEach(c => {
             if (c.voiceUsers.includes(user.id)) {
                 c.voiceUsers = c.voiceUsers.filter(id => id !== user.id);
                 broadcastToRoom(currentRoomCode!, {
                   type: 'USER_LEFT_VOICE', 
                   payload: { userId: user.id, channelId: c.id }
                 });
             }
          });

          broadcastToRoom(currentRoomCode, {
            type: 'VOICE_STATE_UPDATED',
            payload: room.channels
          });

          broadcastToRoom(currentRoomCode, {
            type: 'USER_LEFT',
            payload: {
              userId: user.id,
              systemMessage: leaveMsg,
              users: Array.from(room.users.values())
            }
          });
        }

        if (room.clients.size === 0) {
          rooms.delete(currentRoomCode);
        }
      }
    });
  });

  function broadcastToRoom(roomCode: string, data: any) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const messageStr = JSON.stringify(data);
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeRooms: rooms.size });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
