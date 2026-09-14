const axios = require('axios');

function parseAmount(raw) {
  if (typeof raw === 'number') return raw;
  if (!raw) return 0;
  const n = Number(String(raw).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function classifySegment(klass, nishClasses, entClasses) {
  const k = Number(klass);
  if (nishClasses.includes(k)) return 'nish';
  if (entClasses.includes(k)) return 'ent';
  return null;
}

// Забирает "сырой" лог продаж из Google Таблицы (через опубликованный Apps Script)
// и приводит к плоскому виду, готовому для сохранения в БД.
async function fetchGeneralSales() {
  const { GOOGLE_SHEET_API_URL, NISH_CLASSES, ENT_CLASSES } = process.env;
  if (!GOOGLE_SHEET_API_URL) {
    return []; // источник не подключен — просто ничего не возвращаем, не ломаем остальной сервис
  }

  const nishClasses = (NISH_CLASSES || '3,4,5,6').split(',').map(Number);
  const entClasses = (ENT_CLASSES || '9,10,11').split(',').map(Number);

  const { data } = await axios.get(GOOGLE_SHEET_API_URL, {
    validateStatus: () => true,
    maxRedirects: 5,
  });

  // Скрипт может вернуть данные строкой (если Content-Type не application/json) — подстрахуемся
  const rows = typeof data === 'string' ? JSON.parse(data) : data;
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((r) => r['Айди сделки'] && r['Дата оплаты'])
    .map((r) => {
      const klass = r['Класс'];
      const segment = classifySegment(klass, nishClasses, entClasses);
      const paymentType = r['Тип оплаты'] || '';
      const isNew = paymentType.includes('нового договора');

      return {
        id: String(r['Айди сделки']),
        name: r['ФИО'] || '',
        amount: parseAmount(r['Сумма оплаты']),
        klass: klass || null,
        segment, // 'nish' | 'ent' | null
        payment_type: paymentType,
        is_new: isNew ? 1 : 0,
        date: (r['Дата оплаты'] || '').slice(0, 10), // YYYY-MM-DD
        manager: r['Менеджер'] || '',
        synced_at: new Date().toISOString(),
      };
    })
    // строки без определённого сегмента (НИШ/ЕНТ) отбрасываем — это либо офлайн, либо не наш продукт
    .filter((r) => r.segment !== null);
}

module.exports = { fetchGeneralSales };
