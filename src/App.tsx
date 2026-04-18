import React, { useState, useEffect, useRef } from 'react';
import { Send, Users, Hash, LogOut, MessageSquare, Menu, Plus, Mic, MicOff, Volume2 } from 'lucide-react';
import Peer, { DataConnection, MediaConnection } from 'peerjs';
import { v4 as uuidv4 } from 'uuid';

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
  const [mode, setMode] = useState<'LOGIN' | 'HOST' | 'GUEST'>('LOGIN');
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');
  
  const [myUserId, setMyUserId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatUsers, setChatUsers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  
  const [activeChannelId, setActiveChannelId] = useState<string>('geral');
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [isMuted, setIsMuted] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeChannelIdRef = useRef(activeChannelId);
  const isMutedRef = useRef(isMuted);
  const myUserIdRef = useRef<string>(myUserId);
  const localStreamRef = useRef<MediaStream | null>(localStream);

  // PeerJS instances
  const peerRef = useRef<Peer | null>(null);
  const hostDataConnectionsRef = useRef<DataConnection[]>([]);
  const guestDataConnectionRef = useRef<DataConnection | null>(null);
  const mediaConnectionsRef = useRef<Record<string, MediaConnection>>({});

  // Host State Source of Truth
  const hostStateRef = useRef({
    messages: [] as ChatMessage[],
    users: [] as User[],
    channels: [{ id: 'geral', name: 'geral', voiceUsers: [] }] as Channel[]
  });

  useEffect(() => { activeChannelIdRef.current = activeChannelId; }, [activeChannelId]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { myUserIdRef.current = myUserId; }, [myUserId]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = isMuted;
      });
    }
    setIsMuted(!isMuted);
  };

  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomCode.trim()) {
      setError('Nome e Código são obrigatórios.');
      return;
    }
    
    const hostPeerId = `chat-live-${roomCode.trim().toLowerCase()}`;
    const peer = new Peer(hostPeerId, {
      debug: 2
    });

    peer.on('open', (id) => {
      setMyUserId(id);
      setMode('HOST');
      setError('');

      hostStateRef.current.users = [{ id, username: username.trim() }];
      syncHostStateToUI();
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        hostDataConnectionsRef.current.push(conn);
        
        conn.on('data', (dataStr: any) => {
          const data = JSON.parse(dataStr);
          handleHostReceiveAction(data);
        });

        conn.on('close', () => {
          handleGuestDisconnect(conn.peer);
        });
      });
    });

    peer.on('call', handleIncomingCall);
    peer.on('error', (err) => {
      console.error(err);
      setError('Erro ao criar sala. Talvez o código já esteja em uso por outro Host.');
    });

    peerRef.current = peer;
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !roomCode.trim()) {
      setError('Nome e Código são obrigatórios.');
      return;
    }

    const hostPeerId = `chat-live-${roomCode.trim().toLowerCase()}`;
    // Random ID for guest
    const peer = new Peer({ debug: 2 });

    peer.on('open', (id) => {
      setMyUserId(id);
      
      const conn = peer.connect(hostPeerId);
      conn.on('open', () => {
        guestDataConnectionRef.current = conn;
        setMode('GUEST');
        setError('');

        conn.send(JSON.stringify({
          type: 'JOIN',
          userId: id,
          username: username.trim()
        }));
      });

      conn.on('data', (dataStr: any) => {
        const data = JSON.parse(dataStr);
        handleGuestReceiveSync(data);
      });

      conn.on('close', () => {
        handleLeave();
      });

      conn.on('error', () => {
        setError('O Host desconectou ou não foi encontrado.');
      });
    });

    peer.on('call', handleIncomingCall);
    peer.on('error', (err) => {
      console.error(err);
      setError('Erro de conexão P2P.');
    });

    peerRef.current = peer;
  };

  // --- HOST LOGIC --- //
  const handleHostReceiveAction = (data: any) => {
    const s = hostStateRef.current;
    
    if (data.type === 'JOIN') {
      s.users.push({ id: data.userId, username: data.username });
      
      const joinMsg: ChatMessage = {
        id: uuidv4(),
        userId: 'SYSTEM',
        username: 'Sistema',
        text: `${data.username} entrou na sala.`,
        timestamp: Date.now(),
        channelId: 'geral'
      };
      s.messages.push(joinMsg);
      broadcastHostState();
    }
    else if (data.type === 'MESSAGE') {
      const msg: ChatMessage = {
        id: uuidv4(),
        userId: data.userId,
        username: data.username,
        text: data.text,
        timestamp: Date.now(),
        channelId: data.channelId
      };
      s.messages.push(msg);
      if (s.messages.length > 500) s.messages.shift();
      broadcastHostState();
    }
    else if (data.type === 'CREATE_CHANNEL') {
      s.channels.push({
        id: uuidv4(),
        name: data.channelName,
        voiceUsers: []
      });
      broadcastHostState();
    }
    else if (data.type === 'JOIN_VOICE') {
      // Remove from old
      s.channels.forEach(c => {
        c.voiceUsers = c.voiceUsers.filter(id => id !== data.userId);
      });
      // Add to new
      const ch = s.channels.find(c => c.id === data.channelId);
      if (ch) ch.voiceUsers.push(data.userId);
      broadcastHostState();
    }
    else if (data.type === 'LEAVE_VOICE') {
      s.channels.forEach(c => {
        c.voiceUsers = c.voiceUsers.filter(id => id !== data.userId);
      });
      broadcastHostState();
    }
  };

  const handleGuestDisconnect = (peerId: string) => {
    hostDataConnectionsRef.current = hostDataConnectionsRef.current.filter(c => c.peer !== peerId);
    
    const s = hostStateRef.current;
    const user = s.users.find(u => u.id === peerId);
    if (user) {
      s.users = s.users.filter(u => u.id !== peerId);
      s.channels.forEach(c => {
        c.voiceUsers = c.voiceUsers.filter(id => id !== peerId);
      });

      s.messages.push({
        id: uuidv4(),
        userId: 'SYSTEM',
        username: 'Sistema',
        text: `${user.username} saiu da sala.`,
        timestamp: Date.now(),
        channelId: 'geral'
      });
      broadcastHostState();
    }
  };

  const broadcastHostState = () => {
    syncHostStateToUI();
    const str = JSON.stringify({
      type: 'STATE_SYNC',
      payload: hostStateRef.current
    });
    hostDataConnectionsRef.current.forEach(c => {
      if (c.open) c.send(str);
    });
  };

  const syncHostStateToUI = () => {
    setChatUsers([...hostStateRef.current.users]);
    setMessages([...hostStateRef.current.messages]);
    setChannels([...hostStateRef.current.channels]);
  };

  // --- GUEST LOGIC --- //
  const handleGuestReceiveSync = (data: any) => {
    if (data.type === 'STATE_SYNC') {
      setMessages(data.payload.messages);
      setChatUsers(data.payload.users);
      setChannels(data.payload.channels);
    }
  };

  const sendAction = (action: any) => {
    const fullAction = { ...action, userId: myUserIdRef.current, username };
    if (mode === 'HOST') {
      handleHostReceiveAction(fullAction);
    } else if (guestDataConnectionRef.current?.open) {
      guestDataConnectionRef.current.send(JSON.stringify(fullAction));
    }
  };

  // --- MEDIA LOGIC (WebRTC via PeerJS inside same channel) --- //
  const handleIncomingCall = (call: MediaConnection) => {
    if (call.peer === myUserIdRef.current) {
       call.close();
       return;
    }
    // using a ref for local stream to ensure latest is always fetched on incoming call
    const currentStream = localStreamRef.current;
    if (call.metadata?.channelId === activeChannelIdRef.current && currentStream) {
       if (mediaConnectionsRef.current[call.peer]) {
          mediaConnectionsRef.current[call.peer].close();
       }
       call.answer(currentStream);
       call.on('stream', remoteStream => {
          setRemoteStreams(prev => ({ ...prev, [call.peer]: remoteStream }));
       });
       call.on('close', () => {
          setRemoteStreams(prev => {
             const next = { ...prev };
             if (mediaConnectionsRef.current[call.peer] === call) {
                 delete next[call.peer];
             }
             return next;
          });
       });
       mediaConnectionsRef.current[call.peer] = call;
    } else {
       call.close();
    }
  };

  useEffect(() => {
    if (mode === 'LOGIN') return;
    
    let isCancelled = false;
    let stream: MediaStream | null = null;

    // Join new Audio Channel
    navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    })
      .then(s => {
        if (isCancelled) {
          s.getTracks().forEach(t => t.stop());
          return;
        }
        s.getAudioTracks().forEach(t => { t.enabled = !isMutedRef.current; });
        stream = s;
        setLocalStream(s);

        sendAction({ type: 'JOIN_VOICE', channelId: activeChannelId });

        // Call everyone currently in the channel!
        const currentChannel = channels.find(c => c.id === activeChannelId);
        if (currentChannel && peerRef.current) {
           currentChannel.voiceUsers.forEach(peerId => {
               if (peerId === myUserIdRef.current) return;

               if (mediaConnectionsRef.current[peerId]) {
                   mediaConnectionsRef.current[peerId].close();
               }

               const call = peerRef.current!.call(peerId, s, { metadata: { channelId: activeChannelId } });
               if (call) {
                 call.on('stream', remoteStream => {
                    setRemoteStreams(prev => ({ ...prev, [peerId]: remoteStream }));
                 });
                 call.on('close', () => {
                    setRemoteStreams(prev => {
                       const next = { ...prev };
                       if (mediaConnectionsRef.current[peerId] === call) {
                          delete next[peerId];
                       }
                       return next;
                    });
                 });
                 mediaConnectionsRef.current[peerId] = call;
               }
           });
        }
      })
      .catch(e => console.error("Mic access denied/error:", e));

    return () => {
       isCancelled = true;
       if (stream) {
          stream.getTracks().forEach(t => t.stop());
       }
       setLocalStream(null);
       
       sendAction({ type: 'LEAVE_VOICE', channelId: activeChannelId });

       // Close all active calls
       Object.values(mediaConnectionsRef.current).forEach((c: MediaConnection) => c.close());
       mediaConnectionsRef.current = {};
       setRemoteStreams(prev => { 
          return {}; 
       });
    };
  }, [activeChannelId, mode]);

  // --- UI ACTIONS --- //
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim()) return;

    sendAction({
      type: 'MESSAGE',
      text: messageInput.trim(),
      channelId: activeChannelId
    });

    setMessageInput('');
  };

  const handleCreateChannel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    
    sendAction({
      type: 'CREATE_CHANNEL',
      channelName: newChannelName.trim()
    });
    
    setNewChannelName('');
    setIsCreatingChannel(false);
  };

  const handleLeave = () => {
    if (peerRef.current) {
      peerRef.current.destroy();
    }
    setMode('LOGIN');
    setMessages([]);
    setChatUsers([]);
    setChannels([]);
    setError('');
    // Remote streams are cleared by unmount or voice hooks
  };

  const handleChannelSelect = (id: string) => {
    setActiveChannelId(id);
    setSidebarOpen(false); // Auto-close sidebar on mobile
  };

  if (mode === 'LOGIN') {
    return (
      <div className="min-h-[100dvh] bg-zinc-900 flex items-center justify-center p-4">
        <div className="bg-zinc-800 p-6 md:p-8 rounded-xl shadow-2xl w-full max-w-[95%] md:max-w-md border border-zinc-700">
          <div className="flex justify-center mb-6">
            <div className="bg-indigo-500 p-3 rounded-full">
              <MessageSquare className="w-8 h-8 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-white mb-2">Entrar no Chat</h1>
          <p className="text-zinc-400 text-center mb-8 text-sm">
            Hospede a sala no seu navegador, ou entre usando um código.
          </p>
          
          <form className="space-y-4">
            <div>
              <label className="block text-zinc-400 text-sm font-medium mb-1 uppercase tracking-wider">Seu Apelido</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded-md px-4 py-3 text-base outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                placeholder="Ex: romulo"
                maxLength={20}
              />
            </div>
            <div>
              <label className="block text-zinc-400 text-sm font-medium mb-1 uppercase tracking-wider">Código de Acesso da Sala</label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toLowerCase())}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded-md px-4 py-3 text-base outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                placeholder="ex: sala-secreta"
                maxLength={30}
              />
            </div>
            
            {error && <p className="text-red-400 text-sm">{error}</p>}
            
            <div className="flex flex-col gap-3 pt-4">
              <button
                onClick={handleJoinRoom}
                type="button"
                className="w-full bg-indigo-500 hover:bg-indigo-600 active:bg-indigo-700 text-white font-medium py-3 rounded-md transition-colors"
              >
                Entrar na Sala como Convidado
              </button>
              
              <div className="relative flex py-2 items-center">
                  <div className="flex-grow border-t border-zinc-700"></div>
                  <span className="flex-shrink-0 mx-4 text-zinc-500 text-xs">OU</span>
                  <div className="flex-grow border-t border-zinc-700"></div>
              </div>

              <button
                onClick={handleCreateRoom}
                type="button"
                className="w-full bg-zinc-700 hover:bg-zinc-600 active:bg-zinc-500 text-zinc-200 font-medium py-3 rounded-md transition-colors border border-zinc-600"
              >
                Criar / Hospedar Sala
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] bg-zinc-800 font-sans text-zinc-100 overflow-hidden">
      {Object.entries(remoteStreams).map(([userId, stream]) => {
        const mediaStream = stream as MediaStream;
        if (!mediaStream || typeof mediaStream.getTracks !== 'function') return null;
        return <AudioPlayer key={userId} stream={mediaStream} />;
      })}
      
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
        <div className="h-14 flex items-center px-4 border-b border-zinc-800 font-bold shadow-sm justify-between">
          <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
            <Hash className="w-5 h-5 text-zinc-400 shrink-0" />
            <span>{roomCode}</span>
          </div>
          {mode === 'HOST' && (
            <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/50" title="Você está hospedando o servidor. Se fechar, a sala cai!">
              HOST
            </span>
          )}
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
                    onClick={() => handleChannelSelect(channel.id)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${activeChannelId === channel.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50'}`}
                  >
                    <Hash className="w-4 h-4 shrink-0" />
                    <span className="truncate text-sm font-medium">{channel.name}</span>
                    {activeChannelId === channel.id && localStream && (
                      isMuted ? (
                        <MicOff className="w-3 h-3 text-red-500 ml-auto shrink-0" />
                      ) : (
                        <Mic className="w-3 h-3 text-green-400 ml-auto shrink-0" />
                      )
                    )}
                  </button>
                  {channel.voiceUsers && channel.voiceUsers.length > 0 && (
                    <div className="ml-6 py-1 space-y-1">
                      {channel.voiceUsers.map(vuId => {
                         const u = chatUsers.find(usr => usr.id === vuId);
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
                  className="w-full bg-zinc-950 border border-zinc-700 text-white rounded px-2 py-1.5 text-base md:text-sm outline-none focus:border-indigo-500"
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
              Online — {chatUsers.length}
            </h2>
            <ul className="space-y-2">
              {chatUsers.map(user => (
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

        <div className="p-4 bg-zinc-950 flex items-center justify-between mt-auto">
          <div className="flex items-center gap-2 overflow-hidden">
             <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-white font-bold shrink-0">
                {username.charAt(0).toUpperCase()}
             </div>
             <div className="text-sm font-medium truncate">{username}</div>
          </div>
          <div className="flex items-center gap-1">
            {localStream && (
              <button
                onClick={toggleMute}
                className={`p-2 rounded-md transition-colors ${isMuted ? 'text-red-400 bg-red-400/10 hover:bg-red-400/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                title={isMuted ? "Desmutar Microfone" : "Mutar Microfone"}
              >
                {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>
            )}
            <button 
              onClick={handleLeave}
              className="p-2 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-md transition-colors"
              title="Sair da sala"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#313338]">
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
                                  (msg.timestamp - filteredMessages[index - 1].timestamp < 300000);

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
        <div className="px-3 md:px-4 pb-4 md:pb-6 pt-2 shrink-0 bg-[#313338]">
          <form onSubmit={handleSendMessage} className="relative">
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder={`Conversar em #${channels.find(c => c.id === activeChannelId)?.name || 'geral'}`}
              className="w-full bg-[#383a40] text-zinc-100 rounded-lg pl-3 md:pl-4 pr-12 py-3 text-base md:text-sm outline-none focus:ring-0 placeholder-zinc-500"
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

