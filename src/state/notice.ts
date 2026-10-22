/** Short-lived status messages (e.g. a rejected file while a track keeps playing). */
import { create } from 'zustand';

interface NoticeState {
  message: string | null;
  id: number;
  show: (message: string) => void;
  clear: () => void;
}

let timer: number | undefined;

export const useNotice = create<NoticeState>()((set, get) => ({
  message: null,
  id: 0,
  show: (message) => {
    window.clearTimeout(timer);
    set({ message, id: get().id + 1 });
    timer = window.setTimeout(() => set({ message: null }), 4200);
  },
  clear: () => {
    window.clearTimeout(timer);
    set({ message: null });
  },
}));
