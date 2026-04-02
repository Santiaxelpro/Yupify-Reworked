// src/components/Navigation.jsx
import React from 'react';
import { Home, Search, List, Music, Settings, LogOut } from 'lucide-react';


const Navigation = ({ 
  activeTab, 
  onTabChange, 
  isAuthenticated, 
  user, 
  showUserMenu,
  onToggleUserMenu,
  onLogout,
  quality,
  setQuality
}) => {
  
  const NavButton = ({ icon: Icon, label, tab }) => (
    <button
      onClick={() => onTabChange(tab)}
      className={`flex flex-col md:flex-row items-center gap-1 md:gap-3 px-4 py-2 rounded-lg transition-all ${
        activeTab === tab
          ? 'bg-green-600 text-white'
          : 'text-gray-400 hover:text-white hover:bg-gray-900'
      }`}
    >
      <Icon size={24} />
      <span className="text-xs md:text-sm font-medium">{label}</span>
    </button>
  );

  return (
    <>
      {/* Navegación inferior (MÓVIL) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 flex justify-around py-2 px-2 z-40">
        <NavButton icon={Home} label="Inicio" tab="home" />
        <NavButton icon={Search} label="Buscar" tab="search" />
        <NavButton icon={List} label="Cola" tab="queue" />
        <NavButton icon={Music} label="Biblioteca" tab="library" />
      </nav>

      {/* Navegación lateral (DESKTOP) - Oculta en viewports pequeños */}
      <nav className="
        hidden lg:flex 
        fixed left-0 
        top-[72px]
        bottom-0 w-64 
        bg-black
        border-r border-gray-800 
        flex-col p-4 gap-3
        z-30
        overflow-y-auto
      ">
        <NavButton icon={Home} label="Inicio" tab="home" />
        <NavButton icon={Search} label="Buscar" tab="search" />
        <NavButton icon={List} label="Cola" tab="queue" />
        <NavButton icon={Music} label="Biblioteca" tab="library" />

{/* SELECTOR DE CALIDAD DE AUDIO */}
<div className="mt-3">
  <label className="text-gray-400 text-xs font-semibold px-1">
    Calidad de audio
  </label>

  <select
    className="mt-1 w-full bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg px-3 py-2 outline-none focus:border-green-500 transition"
    value={quality}
    onChange={(e) => {
      const q = e.target.value;
      setQuality(q);
      localStorage.setItem("audioQuality", q);
    }}
  >
    <option value="HI_RES_LOSSLESS">HI-RES</option>
    <option value="LOSSLESS">LOSSLESS (FLAC sin pérdida)</option>
    <option value="HIGH">HIGH (ALTA MP3 320KBPS)</option>
    <option value="LOW">LOW (BAJA MP3 96KBPS)</option>
  </select>
</div>

        <div className="border-t border-gray-800 mt-auto pt-4">
          {isAuthenticated && user && (
            <div className="relative">
              <button
                onClick={onToggleUserMenu}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-800/50 hover:bg-gray-700 transition-all"
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-[#1db954] to-emerald-400 flex items-center justify-center flex-shrink-0">
                  <span className="text-white font-bold text-sm">
                    {user.name?.charAt(0).toUpperCase() || '?'}
                  </span>
                </div>
                <div className="flex-1 text-left min-w-0">
                  <p className="text-sm font-semibold truncate text-white">{user.name}</p>
                  <p className="text-xs text-gray-400 truncate">{user.email}</p>
                </div>
              </button>
              
              {showUserMenu && (
                <div className="absolute bottom-full left-0 right-0 mb-2 bg-gray-900 rounded-lg shadow-xl p-2 z-50">
                  <button className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-200 text-sm">
                    <Settings size={18} />
                    <span>Configuración</span>
                  </button>
                  <button 
                    onClick={onLogout}
                    className="w-full flex items-center gap-3 px-4 py-2 hover:bg-red-900/30 rounded-lg transition-colors text-red-400 text-sm"
                  >
                    <LogOut size={18} />
                    <span>Cerrar Sesión</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </nav>
    </>
  );
};

export default Navigation;
