import { el, replace } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { run } from '../core/feedback.js';
import { loader } from './loader.js';
import { pagination } from './pagination.js';

// Table with server-side paging, sorting and filters (A10).
//   columns: [{ key, label, sortable, render(row) -> Node | string }]
//   load({ page, pageSize, sort, direction, ...filters }) -> { data, meta }
//   filters: [{ name, label, type: 'text' | 'select', options }]
export function dataTable({ columns, load, filters = [], pageSize = 20, initialSort, rowKey = 'id' }) {
  const state = { page: 1, sort: initialSort?.key, direction: initialSort?.direction ?? 'asc', filters: {} };
  const body = el('div', { className: 'table-body' });
  const footer = el('div', { className: 'table-footer' });

  const filterBar = filters.length === 0 ? null : el('form', {
    className: 'filters',
    on: {
      submit: (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        state.filters = Object.fromEntries([...data.entries()].filter(([, value]) => value !== ''));
        state.page = 1;
        refresh();
      },
    },
  }, [
    ...filters.map((filter) => el('label', { className: 'filter' }, [
      el('span', { text: filter.label }),
      filter.type === 'select'
        ? el('select', { attrs: { name: filter.name } }, [el('option', { text: t('common.all'), value: '' }),
          ...filter.options.map((option) => el('option', { text: option.label, value: option.value }))])
        : el('input', { attrs: { name: filter.name, type: filter.type ?? 'search', maxlength: 100 } }),
    ])),
    el('button', { className: 'button', text: t('common.filter'), attrs: { type: 'submit' } }),
  ]);

  function header() {
    return el('tr', {}, columns.map((column) => {
      if (!column.sortable) return el('th', { text: column.label, attrs: { scope: 'col' } });
      const active = state.sort === column.key;
      return el('th', { attrs: { scope: 'col', 'aria-sort': active ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none' } }, [
        el('button', {
          className: 'sort', text: `${column.label}${active ? (state.direction === 'asc' ? ' ▲' : ' ▼') : ''}`, attrs: { type: 'button' },
          on: {
            click: () => {
              state.direction = active && state.direction === 'asc' ? 'desc' : 'asc';
              state.sort = column.key;
              refresh();
            },
          },
        }),
      ]);
    }));
  }

  async function refresh() {
    replace(body, loader());
    const query = { page: state.page, pageSize, ...state.filters };
    if (state.sort) Object.assign(query, { sort: state.sort, direction: state.direction });
    const result = await run(() => load(query));
    if (!result) {
      replace(body, el('p', { className: 'empty', text: t('common.loadFailed') }));
      return;
    }
    const rows = result.data.map((row) => el('tr', { dataset: { key: row[rowKey] } }, columns.map((column) => {
      const value = column.render ? column.render(row) : row[column.key];
      return el('td', {}, [value ?? '—']);
    })));
    replace(body, rows.length === 0
      ? el('p', { className: 'empty', text: t('common.noResults') })
      : el('table', { className: 'table' }, [el('thead', {}, header()), el('tbody', {}, rows)]));
    const total = result.meta?.total ?? result.data.length;
    replace(footer, result.meta?.pageSize ? pagination({
      page: state.page, pageSize, total, onChange: (next) => { state.page = next; refresh(); },
    }) : null);
  }

  const element = el('div', { className: 'data-table' }, [filterBar, body, footer]);
  refresh();
  return { element, refresh };
}
