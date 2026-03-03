// src/utils/discordRpc.js
const isBrowser = typeof window !== 'undefined';

const hasTauriGlobals = () => {
  if (!isBrowser) return false;
  const w = window;
  return Boolean(
    w.__TAURI__ ||
    w.__TAURI_INTERNALS__ ||
    w.__TAURI_IPC__ ||
    w.__TAURI_METADATA__
  );
};

const isTauriUserAgent = () => {
  if (!isBrowser) return false;
  const ua = navigator?.userAgent || '';
  return /tauri/i.test(ua);
};

export const isTauriApp = () => hasTauriGlobals() || isTauriUserAgent();

let invokePromise = null;
const getInvoke = async () => {
  if (!isBrowser) return null;
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
