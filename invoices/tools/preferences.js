const db = require('../db');

// =============================================
// USER PREFERENCES
//
// Standing preferences the AI should keep applying
// automatically for a given Telegram chat, stored outside
// the AI's context window so they survive a new session or
// a bot restart. Scoped by chat_id — never shared across
// chats.
//
// Only ever called when the model has judged the user is
// explicitly asking to save/remember/set a standing
// preference (enforced in the system prompt, not here) —
// this module itself just persists whatever key/value it is
// given for that chat.
// =============================================

// Preference keys the AI is expected to use, and what a
// valid value looks like. Keeping a known set for
// "default_payment_mode" prevents garbage values (like a
// typo'd payment method) from silently becoming the default
// used on every future bill. Any OTHER key is still allowed
// through, unvalidated, so genuinely new standing
// preferences ("preferred_brand", etc.) aren't blocked.
const VALID_PAYMENT_MODES = ['cash', 'credit', 'upi', 'card'];

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function setUserPreference(chatId, key, value) {

  if (chatId == null || String(chatId).trim() === '') {
    return { error: 'chatId is required to save a personal preference.' };
  }

  const normalizedKey = normalizeKey(key);

  if (!normalizedKey) {
    return { error: 'A preference key is required.' };
  }

  if (value == null || String(value).trim() === '') {
    return { error: 'A preference value is required.' };
  }

  let normalizedValue = String(value).trim();

  if (normalizedKey === 'default_payment_mode') {
    normalizedValue = normalizedValue.toLowerCase();
    if (!VALID_PAYMENT_MODES.includes(normalizedValue)) {
      return {
        error: `Invalid default payment mode "${value}". Use one of: ${VALID_PAYMENT_MODES.join(', ')}.`
      };
    }
  }

  db.prepare(`
    INSERT INTO user_preferences (chat_id, key, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id, key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(String(chatId), normalizedKey, normalizedValue);

  return {
    message: 'Preference saved.',
    chat_id: String(chatId),
    key: normalizedKey,
    value: normalizedValue
  };
}

function getUserPreference(chatId, key) {

  if (chatId == null || String(chatId).trim() === '') {
    return { error: 'chatId is required to look up a personal preference.' };
  }

  const normalizedKey = normalizeKey(key);

  if (!normalizedKey) {
    return { error: 'A preference key is required.' };
  }

  const row = db.prepare(`
    SELECT key, value, updated_at
    FROM user_preferences
    WHERE chat_id = ? AND key = ?
  `).get(String(chatId), normalizedKey);

  if (!row) {
    return { key: normalizedKey, value: null, found: false };
  }

  return { key: row.key, value: row.value, found: true, updated_at: row.updated_at };
}

function getAllUserPreferences(chatId) {

  if (chatId == null || String(chatId).trim() === '') {
    return { error: 'chatId is required to look up preferences.' };
  }

  const rows = db.prepare(`
    SELECT key, value, updated_at
    FROM user_preferences
    WHERE chat_id = ?
    ORDER BY key ASC
  `).all(String(chatId));

  return { preferences: rows };
}

// =============================================
// SHOP SETTINGS
//
// Shop-wide identity fields, not chat-scoped. Read
// automatically by tools/invoice.js (GST PDF invoices) and
// tools/business_report.js (PPTX report) via
// getShopConfig() there, so a saved shop name/address/
// phone/GSTIN is applied to every future invoice and report
// without asking again — no code change needed on their
// side, since they already read through getShopConfig().
// =============================================

const SHOP_FIELDS = ['name', 'address', 'phone', 'gstin'];

function setShopSetting(field, value) {

  const normalizedField = String(field || '').trim().toLowerCase();

  if (!SHOP_FIELDS.includes(normalizedField)) {
    return {
      error: `Invalid shop setting "${field}". Use one of: ${SHOP_FIELDS.join(', ')}.`
    };
  }

  if (value == null || String(value).trim() === '') {
    return { error: 'A value is required.' };
  }

  const normalizedValue = String(value).trim();

  db.prepare(`
    INSERT INTO shop_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(normalizedField, normalizedValue);

  return {
    message: 'Shop setting saved.',
    field: normalizedField,
    value: normalizedValue
  };
}

function getShopSettings() {

  const rows = db.prepare(`
    SELECT key, value FROM shop_settings
  `).all();

  const settings = { name: null, address: null, phone: null, gstin: null };

  for (const row of rows) {
    if (SHOP_FIELDS.includes(row.key)) {
      settings[row.key] = row.value;
    }
  }

  return settings;
}

module.exports = {
  setUserPreference,
  getUserPreference,
  getAllUserPreferences,
  setShopSetting,
  getShopSettings,
  SHOP_FIELDS,
  VALID_PAYMENT_MODES
};
