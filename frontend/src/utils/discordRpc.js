// src/utils/discordRpc.js
const isBrowser = typeof window !== 'undefined';

export const isTauriApp = () => {
  if (!isBrowser) return false;
  return Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
};

let invokePromise = null;
const getInvoke = async () => {
  if (!isTauriApp()) return null;
  if (invokePromise) return invokePromise;
  invokePromise = import('@tauri-apps/api/tauri')
    .then(mod => mod.invoke)
    .catch(err => {
      console.warn('Tauri API no disponible:', err);
      return null;
    });
  return invokePromise;
};

export const setDiscordActivity = async (payload) => {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke('rpc_set_activity', { payload });
  } catch (err) {
    console.warn('RPC set_activity fall?:', err);
  }
};

export const clearDiscordActivity = async () => {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke('rpc_clear_activity');
  } catch (err) {
    console.warn('RPC clear_activity fall?:', err);
  }
};

export const disconnectDiscordRpc = async () => {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke('rpc_disconnect');
  } catch (err) {
    console.warn('RPC disconnect fall?:', err);
  }
};
