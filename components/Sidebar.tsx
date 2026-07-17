import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { NAV_STRUCTURE } from '../constants';
import { Menu, ChevronLeft } from 'lucide-react';

export const Sidebar: React.FC = () => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <aside 
      className={`
        fixed top-0 left-0 h-full bg-pubmatic-navy text-white transition-all duration-300 z-50 flex flex-col shadow-xl
        ${isCollapsed ? 'w-20' : 'w-72'}
      `}
    >
      {/* Logo Area */}
      <div className="h-20 flex items-center justify-center border-b border-white/10 bg-black/20 relative">
         {/* Simplified Logo representation */}
        {isCollapsed ? (
             <div className="font-bold text-2xl tracking-tighter text-pubmatic-blue">P</div>
        ) : (
            <div className="flex flex-col items-center">
                <span className="font-bold text-2xl tracking-wide">GCK</span>
                <span className="text-[10px] uppercase tracking-widest text-gray-400">Automation</span>
            </div>
        )}
        
        <button 
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-pubmatic-blue rounded-full flex items-center justify-center shadow-md hover:bg-pubmatic-teal transition-colors md:flex hidden"
        >
            <ChevronLeft size={14} className={`transition-transform ${isCollapsed ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-6 custom-scrollbar">
        {NAV_STRUCTURE.map((section) => (
          <div key={section.id} className="mb-8">
            {!isCollapsed && (
              <h3 className="px-6 text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">
                {section.label}
              </h3>
            )}
            <ul>
              {section.children?.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.path || '#'}
                    className={({ isActive }) => `
                      flex items-center px-6 py-3 transition-colors duration-200
                      ${isActive 
                        ? 'bg-pubmatic-blue text-white border-r-4 border-pubmatic-teal' 
                        : 'text-gray-300 hover:bg-white/5 hover:text-white'
                      }
                      ${isCollapsed ? 'justify-center px-2' : ''}
                    `}
                    title={isCollapsed ? item.label : ''}
                  >
                    {item.icon && <item.icon size={20} className={isCollapsed ? '' : 'mr-3'} />}
                    {!isCollapsed && <span className="text-sm font-medium">{item.label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer / Version */}
      <div className="p-4 border-t border-white/10 text-xs text-center text-gray-500 bg-black/20">
        {!isCollapsed ? 'v0.3.0' : 'v0.3'}
      </div>
    </aside>
  );
};