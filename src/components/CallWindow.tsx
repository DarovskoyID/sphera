import React, { useState } from 'react';
import { Phone, Video, Search, Menu, ArrowLeft, Plus, Smile, Send } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { directMessages, messages, serverChannels } from '../data/mockData';
import { Settings } from './Settings';

export const CallWindow: React.FC = () => {
  const { setCallActive } = useApp();
  return (
  <div style={{"height" : 300, "background" : "black", "display" : "flex", "alignItems" : "flex-end", "flexWrap" : "wrap"}}>
    <div style={{"width" : "100%", "display" : "flex", "alignItems" : "center", "justifyContent" : "center", "gap" : 20}}>
        <button style={{"width" : "80px", "height" : "80px"}} className="profile-avatar-btn">
            <img src="https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100" alt="Profile" />
            <span className="status-indicator online"></span>
        </button>
        <button style={{"width" : "80px", "height" : "80px"}} className="profile-avatar-btn">
            <img src="https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=100" alt="Profile" />
            <span className="status-indicator online"></span>
        </button>   
    </div>
    <div style={{"margin" : "9px 0","width" : "100%", "display" : "flex", "gap" : 12, "justifyContent" : "center"}}>
        <button style={{"background" : "red"}} className="icon-btn glass-btn" onClick={() => setCallActive(false)} title="Voice Call">
            X
        </button>
        <button className="icon-btn glass-btn" onClick={()=>{}} title="Voice Call">
            C
        </button>
        <button className="icon-btn glass-btn" onClick={()=>{}} title="Voice Call">
            M
        </button>
        <button className="icon-btn glass-btn" onClick={()=>{}} title="Voice Call">
            H
        </button>
        <button className="icon-btn glass-btn" onClick={()=>{}} title="Voice Call">
            D
        </button>
    </div>
  </div>)
}