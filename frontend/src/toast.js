import { reactive } from 'vue';

let idSeq = 0;
export const toasts = reactive([]);

export function toast(message, type = 'info', duration = 2600) {
  const id = ++idSeq;
  toasts.push({ id, message, type });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
  }, duration);
}
toast.error = (m) => toast(m, 'error', 4000);
toast.success = (m) => toast(m, 'success');
