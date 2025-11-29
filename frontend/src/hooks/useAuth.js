// src/hooks/useAuth.js
import { useState, useEffect } from 'react';
import api from '../services/api';

export const useAuth = () => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Verificar autenticación al cargar
  useEffect(() => {
    const token = localStorage.getItem('yupify_token');
    const userData = localStorage.getItem('yupify_user');
    
    if (token && userData) {
      try {
        setUser(JSON.parse(userData));
        setIsAuthenticated(true);
      } catch (err) {
        console.error('Error parseando usuario:', err);
        logout();
      }
    }
  }, []);

  // Login
  const login = async (email, password) => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await api.auth.login(email, password);
      setUser(result.user);
      setIsAuthenticated(true);
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Register
  const register = async (email, password, name) => {
    setLoading(true);
    setError(null);
    
    try {
      const result = await api.auth.register(email, password, name);
      setUser(result.user);
      setIsAuthenticated(true);
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Logout
  const logout = () => {
    api.auth.logout();
    setUser(null);
    setIsAuthenticated(false);
  };

  return {
    user,
    isAuthenticated,
    loading,
    error,
    login,
    register,
    logout
  };
};

export default useAuth;