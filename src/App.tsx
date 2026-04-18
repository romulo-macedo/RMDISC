import { useState, useEffect, useRef } from 'react';
import { Send, Users, Hash, LogOut, MessageSquare, Menu, Plus, Mic, Volume2 } from 'lucide-react';

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
  voiceUsers?: string[];
}

interface User {
  id: string;
  username: string;
}

function AudioPlayer({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

export default function App() {
  const [isJoined, setIsJoined] = useState(false);
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');
  
  const [myUserId, setMyUserId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  
  const [activeChannelId, setActiveChannelId] = useState<string>('geral');
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeChannelIdRef = useRef(activeChannelId);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const myUserIdRef = useRef<string>(myUserId);
  const peersRef = useRef<Record<string, RTCPeerConnection>>({});

  useEffect(() => { activeChannelIdRef.current = activeChannelId; }, [activeChannelId]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { myUserIdRef.current = myUserId; }, [myUserId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, [ws]);

  const destroyPeerConnection = (userId: string) => {
    if (peersRef.current[userId]) {
      peersRef.current[userId].close();
      delete peersRef.current[userId];
    }
    setRemoteStreams(prev => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const createPeerConnection = (targetUserId: string, channelId: string, stream: MediaStream, socket: WebSocket) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'WEBRTC_ICE_CANDIDATE',
          targetUserId,
          channelId,
          candidate: event.candidate,
        }));
      }
    };

    pc.ontrack = (event) => {
      setRemoteStreams(prev => ({
        ...prev,
        [targetUserId]: event.streams[0]
      }));
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          destroyPeerConnection(targetUserId);
      }
    };

    peersRef.current[targetUserId] = pc;
    return pc;
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomCode.trim()) {
      setError('Nome de usuário e código da sala são obrigatórios.');
      return;
    }

    const host = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    
    const socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'JOIN',
        roomCode: roomCode.trim().toLowerCase(),
        username: username.trim()
      }));
      setWs(socket);
      setIsJoined(true);
      setError('');
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'ROOM_STATE':
          setMyUserId(data.payload.myUserId);
          setMessages(data.payload.messages);
          setUsers(data.payload.users);
          setChannels(data.payload.channels);
          if (data.payload.channels && data.payload.channels.length > 0) {
            setActiveChannelId(data.payload.channels[0].id);
          }
          break;
        case 'USER_JOINED':
        case 'USER_LEFT':
          setUsers(data.payload.users);
          setMessages(prev => [...prev, data.payload.systemMessage]);
          break;
        case 'NEW_MESSAGE':
          setMessages(prev => [...prev, data.payload]);
          break;
        case 'CHANNEL_CREATED':
          setChannels(prev => [...prev, data.payload]);
          break;
        case 'VOICE_STATE_UPDATED':
          setChannels(data.payload);
          break;
        case 'USER_JOINED_VOICE': {
          const { userId, channelId } = data.payload;
          if (channelId === activeChannelIdRef.current && localStreamRef.current && userId !== myUserIdRef.current) {
            const pc = createPeerConnection(userId, channelId, localStreamRef.current, socket);
            pc.createOffer().then(offer => {
              pc.setLocalDescription(offer);
              socket.send(JSON.stringify({
                type: 'WEBRTC_OFFER',
                targetUserId: userId,
                channelId,
                sdp: offer
              }));
            });
          }
          break;
        }
        case 'WEBRTC_OFFER': {
          const { senderId, sdp, channelId } = data;
          if (channelId !== activeChannelIdRef.current) break;

          if (localStreamRef.current && senderId !== myUserIdRef.current) {
            const pc = createPeerConnection(senderId, activeChannelIdRef.current, localStreamRef.current, socket);
            pc.setRemoteDescription(new RTCSessionDescription(sdp))
              .then(() => pc.createAnswer())
              .then(answer => {
                pc.setLocalDescription(answer);
                socket.send(JSON.stringify({
                  type: 'WEBRTC_ANSWER',
                  targetUserId: senderId,
                  channelId,
                  sdp: answer
                }));
              });
          }
          break;
        }
        case 'WEBRTC_ANSWER': {
          const { senderId, sdp, channelId } = data;
          if (channelId !== activeChannelIdRef.current) break;

          const pc = peersRef.current[senderId];
          if (pc) {
            pc.setRemoteDescription(new RTCSessionDescription(sdp));
          }
          break;
        }
        case 'WEBRTC_ICE_CANDIDATE': {
          const { senderId, candidate, channelId } = data;
          if (channelId !== activeChannelIdRef.current) break;

          const pc = peersRef.current[senderId];
          if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
          break;
        }
        case 'USER_LEFT_VOICE': {
          const { userId } = data.payload;
          destroyPeerConnection(userId);
          break;
        }
      }
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      setError('Erro de conexão. Tente novamente mais tarde.');
    };

    socket.onclose = () => {
      setIsJoined(false);
      setMessages([]);
      setUsers([]);
      setWs(null);
    };
  };

  useEffect(() => {
    if (activeChannelId && isJoined && ws) {
      let stream: MediaStream | null = null;
      let isCancelled = false;

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(s => {
          if (isCancelled) {
            s.getTracks().forEach(t => t.stop());
            return;
          }
          stream = s;
          setLocalStream(s);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'JOIN_VOICE', channelId: activeChannelId }));
          }
        })
        .catch(e => {
          console.error("Microphone access denied or error:", e);
        });

      return () => {
         isCancelled = true;
         if (stream) {
            stream.getTracks().forEach(t => t.stop());
         }
         setLocalStream(null);
         
         if (ws && ws.readyState === WebSocket.OPEN) {
           ws.send(JSON.stringify({ type: 'LEAVE_VOICE', channelId: activeChannelId }));
         }

         Object.values(peersRef.current).forEach(pc => pc.close());
         peersRef.current = {};
         setRemoteStreams({});
      };
    }
  }, [activeChannelId, isJoined, ws]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim() || !ws) return;

    ws.send(JSON.stringify({
      type: 'MESSAGE',
      text: messageInput.trim(),
      channelId: activeChannelId
    }));

    setMessageInput('');
  };

  const handleCreateChannel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim() || !ws) return;
    
    ws.send(JSON.stringify({
      type: 'CREATE_CHANNEL',
      channelName: newChannelName.trim()
    }));
    
    setNewChannelName('');
    setIsCreatingChannel(false);
  };

  const handleLeave = () => {
    if (ws) {
      ws.close();
    }
  };

  if (!isJoined) {
    return (
      <div className="min-h-screen bg-zinc-900 flex items-center justify-center p-4">
        <div className="bg-zinc-800 p-8 rounded-xl shadow-2xl w-full max-w-md border border-zinc-700">
          <div className="flex justify-center mb-6">
            <div className="bg-indigo-500 p-3 rounded-full">
              <MessageSquare className="w-8 h-8 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-white mb-2">Entrar no Chat</h1>
          <p className="text-zinc-400 text-center mb-8 text-sm">Conecte-se com seus amigos usando um código de acesso.</p>
          
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-zinc-400 text-sm font-medium mb-1 uppercase tracking-wider">Como as pessoas te chamarão?</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded-md px-4 py-3 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                placeholder="Seu apelido..."
                maxLength={20}
              />
            </div>
            <div>
              <label className="block text-zinc-400 text-sm font-medium mb-1 uppercase tracking-wider">Código de Acesso da Sala</label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toLowerCase())}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded-md px-4 py-3 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                placeholder="ex: sala-secreta-123"
                maxLength={30}
              />
            </div>
            
            {error && <p className="text-red-400 text-sm">{error}</p>}
            
            <button
              type="submit"
              className="w-full bg-indigo-500 hover:bg-indigo-600 active:bg-indigo-700 text-white font-medium py-3 rounded-md transition-colors mt-4"
            >
              Entrar na Sala
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-zinc-800 font-sans text-zinc-100 overflow-hidden">
      {Object.entries(remoteStreams).map(([userId, stream]) => (
        <AudioPlayer key={userId} stream={stream} />
      ))}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Users */}
      <div className={`
        fixed inset-y-0 left-0 transform ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        md:relative md:translate-x-0 z-30
        w-64 bg-zinc-900 flex flex-col border-r border-zinc-800 transition-transform duration-200 ease-in-out
      `}>
        <div className="h-14 flex items-center px-4 border-b border-zinc-800 font-bold shadow-sm">
          <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
            <Hash className="w-5 h-5 text-zinc-400 shrink-0" />
            <span>{roomCode}</span>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-8">
          <div>
            <h2 className="text-xs uppercase font-bold text-zinc-400 tracking-wider mb-3 flex items-center gap-2">
              Pastas
            </h2>
            <ul className="space-y-1 mb-3">
              {channels.map(channel => (
                <li key={channel.id} className="mb-1">
                  <button
                    onClick={() => setActiveChannelId(channel.id)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${activeChannelId === channel.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50'}`}
                  >
                    <Hash className="w-4 h-4 shrink-0" />
                    <span className="truncate text-sm font-medium">{channel.name}</span>
                    {activeChannelId === channel.id && localStream && (
                      <Mic className="w-3 h-3 text-green-400 ml-auto shrink-0" />
                    )}
                  </button>
                  {channel.voiceUsers && channel.voiceUsers.length > 0 && (
                    <div className="ml-6 py-1 space-y-1">
                      {channel.voiceUsers.map(vuId => {
                         const u = users.find(usr => usr.id === vuId);
                         if (!u) return null;
                         return (
                           <div key={vuId} className="flex items-center gap-2 text-xs text-zinc-400">
                             <div className="relative w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 font-bold shrink-0 text-[10px]">
                               {u.username.charAt(0).toUpperCase()}
                               <div className="absolute -bottom-0.5 -right-0.5 bg-zinc-900 rounded-full">
                                <Volume2 className="w-2.5 h-2.5 text-green-400" />
                               </div>
                             </div>
                             <span className="truncate">{u.username}</span>
                           </div>
                         );
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            
            {isCreatingChannel ? (
              <form onSubmit={handleCreateChannel} className="mt-2">
                <input
                  type="text"
                  autoFocus
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  onBlur={() => setIsCreatingChannel(false)}
                  placeholder="Nome da pasta..."
                  className="w-full bg-zinc-950 border border-zinc-700 text-white rounded px-2 py-1.5 text-sm outline-none focus:border-indigo-500"
                />
              </form>
            ) : (
              <button 
                onClick={() => setIsCreatingChannel(true)}
                className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-indigo-500/30 text-indigo-400 hover:text-indigo-300 hover:border-indigo-400 hover:bg-indigo-500/10 rounded-lg py-2 px-3 transition-all text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                Criar Pasta
              </button>
            )}
          </div>

          <div>
            <h2 className="text-xs uppercase font-bold text-zinc-400 tracking-wider mb-4 flex items-center gap-2">
              <Users className="w-4 h-4" />
              Online — {users.length}
            </h2>
            <ul className="space-y-2">
              {users.map(user => (
                <li key={user.id} className="flex items-center gap-3 text-zinc-300">
                  <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 font-bold shrink-0">
                    {user.username.charAt(0).toUpperCase()}
                  </div>
                  <span className="truncate">{user.username}</span>
                  {user.id === myUserId && (
                    <span className="text-[10px] bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300 ml-auto flex-shrink-0">VOCÊ</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="p-4 bg-zinc-950 flex items-center justify-between">
          <div className="flex items-center gap-2 overflow-hidden">
             <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold shrink-0">
                {username.charAt(0).toUpperCase()}
             </div>
             <div className="text-sm font-medium truncate">{username}</div>
          </div>
          <button 
            onClick={handleLeave}
            className="p-2 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-md transition-colors"
            title="Sair da sala"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#313338]">
        {/* Header */}
        <header className="h-14 flex items-center px-4 border-b border-zinc-900 shadow-sm shrink-0 bg-[#313338]">
          <button 
            className="md:hidden mr-4 text-zinc-400 hover:text-zinc-200"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2 font-medium">
            <Hash className="w-6 h-6 text-zinc-400" />
            <span className="text-lg pb-0.5 bg-clip-text text-transparent bg-gradient-to-r from-zinc-100 to-zinc-400">
              {channels.find(c => c.id === activeChannelId)?.name || 'geral'}
            </span>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div className="flex flex-col items-center justify-center pt-20 pb-10 text-center">
            <div className="w-16 h-16 bg-zinc-700/50 rounded-full flex items-center justify-center mb-4">
              <Hash className="w-10 h-10 text-white" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2">Bem-vindo à pasta {channels.find(c => c.id === activeChannelId)?.name || 'geral'}!</h2>
            <p className="text-zinc-400">Este é o começo do histórico da pasta {channels.find(c => c.id === activeChannelId)?.name || 'geral'}.</p>
          </div>

          {messages.filter(m => m.channelId === activeChannelId || m.userId === 'SYSTEM' && activeChannelId === 'geral').map((msg, index, filteredMessages) => {
            const isSystem = msg.userId === 'SYSTEM';
            const isConsecutive = index > 0 && 
                                  filteredMessages[index - 1].userId === msg.userId && 
                                  !isSystem && 
                                  (msg.timestamp - filteredMessages[index - 1].timestamp < 300000); // 5 minutes

            if (isSystem) {
              return (
                <div key={msg.id} className="flex items-center gap-2 py-1 px-4 text-sm text-zinc-400 bg-zinc-800/30 rounded-md">
                  <span className="shrink-0">→</span>
                  <span>{msg.text}</span>
                  <span className="text-xs opacity-50 ml-auto">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            }

            return (
              <div key={msg.id} className={`flex gap-4 px-4 hover:bg-black/5 rounded py-0.5 ${isConsecutive ? 'mt-1' : 'mt-4'}`}>
                {!isConsecutive ? (
                  <div className="w-10 h-10 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold shrink-0 mt-0.5">
                    {msg.username.charAt(0).toUpperCase()}
                  </div>
                ) : (
                  <div className="w-10 shrink-0 text-right opacity-0 hover:opacity-100 -ml-2 select-none group-hover:opacity-100 flex items-center justify-center">
                     <span className="text-[10px] text-zinc-500">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                     </span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  {!isConsecutive && (
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-medium text-indigo-400 hover:underline cursor-pointer">{msg.username}</span>
                      <span className="text-xs text-zinc-400">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
                  <p className="text-zinc-200 break-words leading-relaxed">{msg.text}</p>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 pb-6 pt-2 shrink-0 bg-[#313338]">
          <form onSubmit={handleSendMessage} className="relative">
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder={`Conversar em #${channels.find(c => c.id === activeChannelId)?.name || 'geral'}`}
              className="w-full bg-[#383a40] text-zinc-100 rounded-lg pl-4 pr-12 py-3.5 outline-none focus:ring-0 placeholder-zinc-500"
              autoFocus
            />
            <button 
              type="submit"
              disabled={!messageInput.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-zinc-400 hover:text-indigo-400 disabled:opacity-50 disabled:hover:text-zinc-400 transition-colors"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

