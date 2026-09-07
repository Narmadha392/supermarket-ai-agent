const {
  setUserPreference,
  getUserPreference,
  setShopSetting,
  getShopSettings
} = require('./preferences');

// =====================================================
// DETERMINISTIC MEMORY COMMANDS
//
// Root cause of "the bot claims it saved something but
// shop.db stays empty": Gemini isn't required to emit a
// function_call — for a phrase like "remember that my X
// is Y" it can just answer in plain text instead. When
// that happens, bot.js's runAgent loop (functionCalls.length
// === 0) returns that text directly. No tool ever runs. No
// error either, because nothing failed — nothing was ever
// attempted. Better tool descriptions can't fully close
// this gap; only bypassing the model's discretion for this
// exact, safety-relevant category can.
//
// So for the four explicitly-required preference fields —
// default payment mode, preferred brand, shop name, GSTIN —
// this recognizes the save/retrieve phrasing BEFORE bot.js
// ever calls Gemini, and calls the real persistence functions
// (tools/preferences.js) directly. The reply is built ONLY
// from what the DB call actually returned, so a claimed save
// always corresponds to a real row. If a message doesn't
// match one of these patterns, this returns null and bot.js
// falls through to the normal Gemini + tools flow (still
// wired, still available for freeform preferences via
// set_preference/get_preference/get_all_preferences).
//
// Pulled into its own module (rather than living inline in
// bot.js) specifically so it can be required and tested
// directly, without bot.js's Telegram/Gemini startup side
// effects running.
// =====================================================

function tryDeterministicMemoryCommand(userText, chatId) {

  const text = String(userText || '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return null;
  }

  const isQuestion = /\?\s*$/.test(text) || /^\s*(what|show|list)\b/i.test(lower);

  // ---------------------------------------------
  // RETRIEVE
  // ---------------------------------------------

  if (isQuestion) {

    if (/\bdefault\s+payment\s+(?:method|mode)\b/i.test(lower)) {
      const pref = getUserPreference(chatId, 'default_payment_mode');
      return (pref && pref.found)
        ? `Your default payment method is currently set to *${pref.value}*.`
        : `You don't have a default payment method saved yet.`;
    }

    if (/\bpreferred\s+brand\b/i.test(lower)) {
      const pref = getUserPreference(chatId, 'preferred_brand');
      return (pref && pref.found)
        ? `Your preferred brand is currently set to *${pref.value}*.`
        : `You don't have a preferred brand saved yet.`;
    }

    if (/\bshop\s*name\b/i.test(lower)) {
      const shop = getShopSettings();
      return shop.name
        ? `Your shop name is currently set to *${shop.name}*.`
        : `No shop name has been saved yet.`;
    }

    if (/\bgstin\b/i.test(lower)) {
      const shop = getShopSettings();
      return shop.gstin
        ? `Your GSTIN on file is *${shop.gstin}*.`
        : `No GSTIN has been saved yet.`;
    }

    return null;

  }

  // ---------------------------------------------
  // SAVE
  // ---------------------------------------------

  const hasSaveIntent =
    /\b(remember|set|save|note|update|make)\b/i.test(lower) ||
    /\b(default\s+payment(?:\s+(?:method|mode))?|preferred\s+brand|shop\s*name|gstin)\b.*\b(is|to|=|:)\b/i.test(lower);

  if (!hasSaveIntent) {
    return null;
  }

  const paymentMatch = lower.match(
    /default\s+payment(?:\s+(?:method|mode))?\s+(?:is|to|=|:)\s*(cash|credit|upi|card)\b/i
  );

  if (paymentMatch) {
    const result = setUserPreference(chatId, 'default_payment_mode', paymentMatch[1].toLowerCase());
    if (result.error) return `I couldn't save that: ${result.error}`;
    return `Got it — your default payment method is now set to *${result.value}*.`;
  }

  const brandMatch = text.match(
    /preferred\s+brand\s+(?:is|to|=|:)\s*([A-Za-z0-9][A-Za-z0-9 &'.-]{0,40}?)[.!]?$/i
  );

  if (brandMatch) {
    const result = setUserPreference(chatId, 'preferred_brand', brandMatch[1].trim());
    if (result.error) return `I couldn't save that: ${result.error}`;
    return `Got it — your preferred brand is now set to *${result.value}*.`;
  }

  const shopNameMatch = text.match(
    /shop\s*name\s+(?:is|to|=|:)\s*([A-Za-z0-9][A-Za-z0-9 &'.-]{0,60}?)[.!]?$/i
  );

  if (shopNameMatch) {
    const result = setShopSetting('name', shopNameMatch[1].trim());
    if (result.error) return `I couldn't save that: ${result.error}`;
    return `Got it — your shop name is now set to *${result.value}*.`;
  }

  const gstinMatch = text.match(
    /gstin\s+(?:is|to|=|:)\s*([A-Za-z0-9]{5,20})\b/i
  );

  if (gstinMatch) {
    const result = setShopSetting('gstin', gstinMatch[1].trim().toUpperCase());
    if (result.error) return `I couldn't save that: ${result.error}`;
    return `Got it — your GSTIN is now set to *${result.value}*.`;
  }

  return null;

}

module.exports = {
  tryDeterministicMemoryCommand
};