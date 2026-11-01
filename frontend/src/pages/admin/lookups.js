import { api } from '../../core/api.js';

// Small lookups shared by the admin pages.
export async function areas() {
  return (await api.get('/api/v1/areas')).data;
}

export async function roles() {
  return (await api.get('/api/v1/roles')).data;
}

export const optionsOf = (items, label = (item) => item.name) => items.map((item) => ({ value: item.id, label: label(item) }));
