/**
 * Tab Management Action Handlers
 * Create, update, delete, and import tab configurations
 */

import * as schema from '../portal-schema.js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, method = 'GET', body = null) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
      'Accept-Profile': 'student',
      'Content-Profile': 'student',
    },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) return { error: text };
  return text ? JSON.parse(text) : [];
}

/**
 * Get all tabs
 */
export async function handleGetTabs(onlyEnabled = false) {
  try {
    let query = 'portal_tabs?order=sort_order.asc';
    if (onlyEnabled) query += '&is_enabled=eq.true';

    const rows = await sb(query);
    if (rows.error) return [];

    return rows.map(r => ({
      ...r,
      fields_json: r.fields_json || '[]',
      condition_json: r.condition_json || '{}',
      include_fields_json: r.include_fields_json || '[]',
    }));
  } catch (err) {
    console.error('handleGetTabs error:', err);
    return [];
  }
}

/**
 * Save or update a tab configuration
 */
export async function handleSaveTab(tabConfig) {
  try {
    const {
      tab_name,
      fields_json,
      condition_json,
      include_fields_json,
      icon_class,
      is_enabled,
      default_editable,
      sort_order,
    } = tabConfig;

    if (!tab_name) {
      return { result: 'error', message: 'Tab name is required' };
    }

    // Validate JSON
    try {
      if (typeof fields_json === 'string') JSON.parse(fields_json);
      if (typeof condition_json === 'string') JSON.parse(condition_json);
      if (typeof include_fields_json === 'string') JSON.parse(include_fields_json);
    } catch (e) {
      return { result: 'error', message: 'Invalid JSON in configuration: ' + e.message };
    }

    // Check if tab exists
    const existing = await sb(
      `portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`
    );

    const payload = {
      tab_name,
      fields_json: typeof fields_json === 'string' ? fields_json : JSON.stringify(fields_json || []),
      condition_json: typeof condition_json === 'string' ? condition_json : JSON.stringify(condition_json || {}),
      include_fields_json: typeof include_fields_json === 'string' ? include_fields_json : JSON.stringify(include_fields_json || []),
      icon_class: icon_class || 'bi-journal-bookmark-fill',
      is_enabled: is_enabled !== false,
      default_editable: default_editable !== false ? 'YES' : 'NO',
      sort_order: sort_order || 0,
      updated_at: new Date().toISOString(),
    };

    if (existing && !existing.error && existing.length > 0) {
      // Update existing
      await sb(
        `portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`,
        'PATCH',
        payload
      );
      return { result: 'success', message: 'Tab updated successfully' };
    } else {
      // Create new
      payload.created_at = new Date().toISOString();
      await sb('portal_tabs', 'POST', payload);
      return { result: 'success', message: 'Tab created successfully' };
    }
  } catch (err) {
    console.error('handleSaveTab error:', err);
    return { result: 'error', message: 'Save failed: ' + err.message };
  }
}

/**
 * Delete a tab
 */
export async function handleDeleteTab(tabName) {
  try {
    await sb(
      `portal_tabs?tab_name=eq.${encodeURIComponent(tabName)}`,
      'DELETE'
    );

    // Also delete all submissions for this tab
    await sb(
      `portal_submissions?tab_name=eq.${encodeURIComponent(tabName)}`,
      'DELETE'
    );

    return { result: 'success', message: 'Tab and related data deleted' };
  } catch (err) {
    console.error('handleDeleteTab error:', err);
    return { result: 'error', message: 'Delete failed: ' + err.message };
  }
}

/**
 * Toggle tab enabled/disabled
 */
export async function handleToggleTabEnabled(tabName, isEnabled) {
  try {
    await sb(
      `portal_tabs?tab_name=eq.${encodeURIComponent(tabName)}`,
      'PATCH',
      { is_enabled: isEnabled }
    );

    return { result: 'success', message: isEnabled ? 'Tab enabled' : 'Tab disabled' };
  } catch (err) {
    console.error('handleToggleTabEnabled error:', err);
    return { result: 'error', message: err.message };
  }
}

/**
 * Reorder tabs (update sort_order for multiple tabs)
 */
export async function handleReorderTabs(tabOrders) {
  try {
    // tabOrders = [{ tab_name, sort_order }, ...]
    const promises = tabOrders.map(item =>
      sb(
        `portal_tabs?tab_name=eq.${encodeURIComponent(item.tab_name)}`,
        'PATCH',
        { sort_order: item.sort_order }
      )
    );

    await Promise.all(promises);
    return { result: 'success', message: 'Tab order updated' };
  } catch (err) {
    console.error('handleReorderTabs error:', err);
    return { result: 'error', message: err.message };
  }
}

/**
 * Import tabs from JSON
 */
export async function handleImportTabs(tabsJson, mergeMode = 'update') {
  try {
    let tabs = typeof tabsJson === 'string' ? JSON.parse(tabsJson) : tabsJson;
    if (!Array.isArray(tabs)) {
      return { result: 'error', message: 'Expected array of tabs' };
    }

    const results = {
      created: [],
      updated: [],
      skipped: [],
      errors: [],
    };

    for (const tab of tabs) {
      try {
        // Validate required fields
        if (!tab.tab_name) {
          results.skipped.push({ tab_name: '(unnamed)', reason: 'Missing tab_name' });
          continue;
        }

        // Check if exists
        const existing = await sb(
          `portal_tabs?tab_name=eq.${encodeURIComponent(tab.tab_name)}`
        );

        const isExists = existing && !existing.error && existing.length > 0;

        if (isExists && mergeMode === 'skip') {
          results.skipped.push({ tab_name: tab.tab_name, reason: 'Tab already exists' });
          continue;
        }

        // Save tab
        const saveResult = await handleSaveTab(tab);
        if (saveResult.result === 'success') {
          if (isExists) {
            results.updated.push(tab.tab_name);
          } else {
            results.created.push(tab.tab_name);
          }
        } else {
          results.errors.push({ tab_name: tab.tab_name, error: saveResult.message });
        }
      } catch (e) {
        results.errors.push({ tab_name: tab.tab_name, error: e.message });
      }
    }

    return {
      result: 'success',
      message: `Imported ${results.created.length} new tabs, updated ${results.updated.length}`,
      details: results,
    };
  } catch (err) {
    console.error('handleImportTabs error:', err);
    return { result: 'error', message: 'Import failed: ' + err.message };
  }
}

/**
 * Export all tabs as JSON
 */
export async function handleExportTabs(format = 'json') {
  try {
    const tabs = await handleGetTabs();

    if (format === 'csv') {
      // Convert to CSV
      const headers = ['tab_name', 'icon_class', 'is_enabled', 'default_editable', 'sort_order', 'fields_count'];
      const rows = tabs.map(t => [
        t.tab_name,
        t.icon_class,
        t.is_enabled ? 'yes' : 'no',
        t.default_editable === 'YES' ? 'yes' : 'no',
        t.sort_order || 0,
        (schema.parseTabFields(t.fields_json) || []).length,
      ]);

      const csv = [
        headers.join(','),
        ...rows.map(r => r.map(cell => {
          const str = String(cell);
          return str.includes(',') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(',')),
      ].join('\n');

      return {
        result: 'success',
        data: csv,
        filename: `portal_tabs_${new Date().toISOString().split('T')[0]}.csv`,
      };
    }

    // JSON format
    return {
      result: 'success',
      data: tabs,
      filename: `portal_tabs_${new Date().toISOString().split('T')[0]}.json`,
    };
  } catch (err) {
    console.error('handleExportTabs error:', err);
    return { result: 'error', message: err.message };
  }
}

export default {
  handleGetTabs,
  handleSaveTab,
  handleDeleteTab,
  handleToggleTabEnabled,
  handleReorderTabs,
  handleImportTabs,
  handleExportTabs,
};
