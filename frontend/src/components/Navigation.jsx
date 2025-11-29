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
  onLogout 
}) => {
  
  const NavButton = ({ icon: Icon, label, tab }) => (
    <button
      onClick={() => onTabChange(tab)}
      className={`flex flex-col md:flex-row items-center gap-1 md:gap-3 px-4 py-2 rounded-lg transition-all ${
        activeTab === tab
          ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg'
          : 'text-gray-400 hover:text-white hover:bg-gray-800'
      }`}
    >
      <Icon size={24} />
      <span className="text-xs md:text-sm font-medium">{label}</span>
    </button>
  );

  return (
    <>
      {/* Navegación inferior (MÓVIL) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur-xl border-t border-gray-800 flex justify-around py-2 px-2 z-40">
        <NavButton icon={Home} label="Inicio" tab="home" />
        <NavButton icon={Search} label="Buscar" tab="search" />
        <NavButton icon={List} label="Cola" tab="queue" />
        <NavButton icon={Music} label="Biblioteca" tab="library" />
      </nav>

      {/* Navegación lateral (DESKTOP) */}
      <nav className="
        hidden md:flex 
        fixed left-0 
        top-[72px]                /* ← ¡ARREGLADO! YA NO TAPA NADA */
        bottom-0 w-64 
        bg-gray-950/50 
        backdrop-blur-xl 
        border-r border-gray-800 
        flex-col p-4 gap-2 
        z-30
      ">
        <NavButton icon={Home} label="Inicio" tab="home" />
        <NavButton icon={Search} label="Buscar" tab="search" />
        <NavButton icon={List} label="Cola" tab="queue" />
        <NavButton icon={Music} label="Biblioteca" tab="library" />

        <div className="mt-auto space-y-2">
          {isAuthenticated && user && (
            <div className="relative">
              <button
                onClick={onToggleUserMenu}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors"
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-purple-600 to-pink-600 flex items-center justify-center">
                  <span className="text-white font-bold">
                    {user.name?.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 text-left">
                  <p className="text-sm font-semibold truncate">{user.name}</p>
                  <p className="text-xs text-gray-400 truncate">{user.email}</p>
                </div>
              </button>
              
              {showUserMenu && (
                <div className="absolute bottom-full left-0 right-0 mb-2 bg-gray-900 rounded-lg shadow-xl p-2">
                  <button className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-800 rounded-lg transition-colors">
                    <Settings size={18} />
                    <span>Configuración</span>
                  </button>
                  <button 
                    onClick={onLogout}
                    className="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-800 rounded-lg transition-colors text-red-400"
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
