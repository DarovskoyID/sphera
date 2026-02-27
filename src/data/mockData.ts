import { DirectMessage, ServerChannel, Message } from '../types';

export const directMessages: Record<string, DirectMessage> = {
  '1': {
    id: '1',
    name: 'Alex Morgan',
    avatar: 'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=100',
    status: 'online',
    lastMessage: 'Hey, are you free later?',
    lastMessageTime: '2m',
    unread: 2,
    isActive: true
  },
  '2': {
    id: '2',
    name: 'Jordan Lee',
    avatar: 'https://images.pexels.com/photos/1222271/pexels-photo-1222271.jpeg?auto=compress&cs=tinysrgb&w=100',
    status: 'idle',
    lastMessage: 'Check out this new feature!',
    lastMessageTime: '15m',
    unread: 0
  },
  '3': {
    id: '3',
    name: 'Sam Rivera',
    avatar: 'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=100',
    status: 'dnd',
    lastMessage: 'Thanks for the help!',
    lastMessageTime: '1h',
    unread: 1
  },
  '4': {
    id: '4',
    name: 'Casey Parker',
    avatar: 'https://images.pexels.com/photos/1239291/pexels-photo-1239291.jpeg?auto=compress&cs=tinysrgb&w=100',
    status: 'offline',
    lastMessage: 'See you tomorrow!',
    lastMessageTime: '3h',
    unread: 0
  }
};

export const serverChannels: Record<string, ServerChannel> = {
  '1': {
    id: '1',
    name: 'Gaming Crew',
    abbr: 'GC',
    description: 'A place for gamers to hang out, find teammates, and talk about everything gaming.',
    banner: 'https://images.pexels.com/photos/3165335/pexels-photo-3165335.jpeg?auto=compress&cs=tinysrgb&w=1200',
    accent: '#16a34a',
    members: 1248,
    online: 342,
    notifications: 12,
    channels: ['general', 'random', 'announcements', 'gaming', 'lfg'],
    voiceChannels: ['Lounge', 'Gaming Room']
  },
  '2': {
    id: '2',
    name: 'Dev Community',
    abbr: 'DC',
    description: 'Discuss code, share projects, get help and learn together with developers of all skill levels.',
    banner: 'https://images.pexels.com/photos/1181271/pexels-photo-1181271.jpeg?auto=compress&cs=tinysrgb&w=1200',
    accent: '#2563eb',
    members: 5830,
    online: 914,
    channels: ['general', 'help', 'announcements', 'showcase', 'resources'],
    voiceChannels: ['Study Hall', 'Pair Programming']
  },
  '3': {
    id: '3',
    name: 'Music Lovers',
    abbr: 'ML',
    description: 'Share your favorite tracks, discuss genres, and connect with fellow music enthusiasts.',
    banner: 'https://images.pexels.com/photos/1626481/pexels-photo-1626481.jpeg?auto=compress&cs=tinysrgb&w=1200',
    accent: '#dc2626',
    members: 2190,
    online: 488,
    notifications: 5,
    channels: ['general', 'recommendations', 'playlists', 'events'],
    voiceChannels: ['Listening Party', 'Jam Session']
  },
  '4': {
    id: '4',
    name: 'Study Group',
    abbr: 'SG',
    description: 'A focused community for students to collaborate, share resources and stay motivated.',
    banner: 'https://images.pexels.com/photos/256490/pexels-photo-256490.jpeg?auto=compress&cs=tinysrgb&w=1200',
    accent: '#d97706',
    members: 763,
    online: 129,
    channels: ['general', 'study-hall', 'resources', 'off-topic'],
    voiceChannels: ['Study Room', 'Group Discussion']
  }
};

export const messages: Record<string, Message[]> = {
  '1': [
    {
      id: '1',
      author: 'Alex Morgan',
      authorId: '1',
      avatar: 'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=100',
      content: 'Hey! How have you been?',
      timestamp: '10:30 AM',
      isOwn: false
    },
    {
      id: '2',
      author: 'You',
      authorId: 'me',
      avatar: 'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100',
      content: 'Pretty good! Just working on some new projects.',
      timestamp: '10:32 AM',
      isOwn: true
    },
    {
      id: '3',
      author: 'Alex Morgan',
      authorId: '1',
      avatar: 'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=100',
      content: 'That sounds exciting! What are you building?',
      timestamp: '10:33 AM',
      isOwn: false
    },
    {
      id: '4',
      author: 'You',
      authorId: 'me',
      avatar: 'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100',
      content: 'A Discord-style messenger app with React. Want to check it out?',
      timestamp: '10:35 AM',
      isOwn: true
    },
    {
      id: '5',
      author: 'Alex Morgan',
      authorId: '1',
      avatar: 'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=100',
      content: 'Absolutely! Send me the link when it\'s ready.',
      timestamp: '10:36 AM',
      isOwn: false
    }
  ]
};

export const currentUser = {
  id: 'me',
  name: 'You',
  avatar: 'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100',
  status: 'online' as const,
  email: 'you@example.com',
  bio: 'Digital explorer & creative thinker'
};
