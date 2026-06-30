/**
 * Admin Tab Manager UI
 * Interface for creating, editing, and configuring tabs
 */

const FIELD_TYPES = {
  text: 'Text Input',
  email: 'Email',
  number: 'Number',
  date: 'Date',
  phone: 'Phone',
  url: 'URL',
  currency: 'Currency',
  textarea: 'Text Area',
  dropdown: 'Dropdown / Select',
  checkbox: 'Checkboxes',
  radio: 'Radio Buttons',
  file: 'File Upload',
  group_label: 'Section Header',
};

const OPERATORS = {
  eq: 'Equals',
  neq: 'Not Equals',
  contains: 'Contains',
  startswith: 'Starts With',
  gt: 'Greater Than',
  lt: 'Less Than',
  in_sheet: 'Has Submitted To',
  not_in_sheet: 'Has Not Submitted To',
};

/**
 * Open tab editor modal
 */
function openTabEditor(tab = null) {
  const isNew = !tab;
  const title = isNew ? 'Create New Tab' : `Edit: ${tab.tab_name}`;

  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.id = 'tab-editor-modal';
  modal.setAttribute('tabindex', '-1');
  modal.innerHTML = `
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header bg-primary text-white">
          <h5 class="modal-title">${title}</h5>
          <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <form id="tab-config-form">
            <!-- Basic Info -->
            <div class="mb-3">
              <label class="form-label fw-600">Tab Name *</label>
              <input type="text" class="form-control" id="tab-name" value="${tab?.tab_name || ''}" placeholder="e.g., Personal Info" required />
            </div>

            <div class="row">
              <div class="col-md-6 mb-3">
                <label class="form-label fw-600">Icon Class</label>
                <input type="text" class="form-control" id="tab-icon" value="${tab?.icon_class || 'bi-journal-bookmark-fill'}" placeholder="e.g., bi-person-fill" />
              </div>
              <div class="col-md-6 mb-3">
                <label class="form-label fw-600">Sort Order</label>
                <input type="number" class="form-control" id="tab-sort" value="${tab?.sort_order || 0}" />
              </div>
            </div>

            <!-- Field Configurator -->
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <label class="form-label fw-600 mb-0">Form Fields</label>
                <button type="button" class="btn btn-sm btn-outline-primary" id="add-field-btn">+ Add Field</button>
              </div>
              <div id="fields-list" class="border rounded p-3" style="min-height: 100px; background: #f8f9fa;">
                <!-- Fields will be added here -->
              </div>
            </div>

            <!-- Visibility Conditions -->
            <div class="mb-3">
              <label class="form-label fw-600">Visibility Conditions</label>
              <div class="mb-2">
                <select id="condition-logic" class="form-select" style="width: 150px;">
                  <option value="AND">Match ALL (AND)</option>
                  <option value="OR">Match ANY (OR)</option>
                </select>
              </div>
              <div id="conditions-list" class="border rounded p-3" style="min-height: 60px; background: #f8f9fa;">
                <!-- Conditions will be added here -->
              </div>
              <button type="button" class="btn btn-sm btn-outline-secondary mt-2" id="add-condition-btn">+ Add Condition</button>
            </div>

            <!-- Include Fields -->
            <div class="mb-3">
              <label class="form-label fw-600">Include Profile Fields (Read-Only)</label>
              <div id="include-fields-container" class="border rounded p-3" style="max-height: 150px; overflow-y: auto; background: #f8f9fa;">
                <!-- Will be populated dynamically -->
              </div>
            </div>

            <!-- Settings -->
            <div class="row">
              <div class="col-md-6 mb-3">
                <div class="form-check">
                  <input type="checkbox" class="form-check-input" id="tab-enabled" checked />
                  <label class="form-check-label" for="tab-enabled">Enabled</label>
                </div>
              </div>
              <div class="col-md-6 mb-3">
                <div class="form-check">
                  <input type="checkbox" class="form-check-input" id="tab-editable" checked />
                  <label class="form-check-label" for="tab-editable">Editable by Default</label>
                </div>
              </div>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="button" class="btn btn-primary" id="save-tab-btn">Save Tab</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const bsModal = new bootstrap.Modal(modal);

  // Populate include fields
  populateIncludeFields();

  // Initialize fields list
  const fieldsList = document.getElementById('fields-list');
  if (tab?.fields_json) {
    try {
      const fields = JSON.parse(tab.fields_json);
      fields.forEach((f, i) => addFieldRow(i, f));
    } catch (e) {
      console.error('Failed to parse fields:', e);
    }
  }

  // Initialize conditions
  const conditionsList = document.getElementById('conditions-list');
  if (tab?.condition_json) {
    try {
      const cond = JSON.parse(tab.condition_json);
      if (cond.logic) {
        document.getElementById('condition-logic').value = cond.logic;
      }
      if (cond.rules && Array.isArray(cond.rules)) {
        cond.rules.forEach((r, i) => addConditionRow(i, r));
      }
    } catch (e) {
      console.error('Failed to parse conditions:', e);
    }
  }

  // Include fields
  if (tab?.include_fields_json) {
    try {
      const incl = JSON.parse(tab.include_fields_json);
      incl.forEach(f => {
        const chk = document.querySelector(`input[value="${f}"]`);
        if (chk) chk.checked = true;
      });
    } catch (e) {
      console.error('Failed to parse include fields:', e);
    }
  }

  // Event listeners
  document.getElementById('add-field-btn').onclick = () => {
    const count = fieldsList.querySelectorAll('.field-row').length;
    addFieldRow(count);
  };

  document.getElementById('add-condition-btn').onclick = () => {
    const count = conditionsList.querySelectorAll('.condition-row').length;
    addConditionRow(count);
  };

  document.getElementById('save-tab-btn').onclick = saveTabConfig;

  bsModal.show();
  modal.addEventListener('hidden.bs.modal', () => modal.remove());
}

/**
 * Add a field configuration row
 */
function addFieldRow(index, fieldDef = {}) {
  const fieldsList = document.getElementById('fields-list');
  const row = document.createElement('div');
  row.className = 'field-row border-bottom pb-2 mb-2';
  row.innerHTML = `
    <div class="row g-2">
      <div class="col-md-3">
        <input type="text" class="form-control form-control-sm field-name" placeholder="Field name" value="${fieldDef.name || ''}" />
      </div>
      <div class="col-md-3">
        <input type="text" class="form-control form-control-sm field-label" placeholder="Label" value="${fieldDef.label || ''}" />
      </div>
      <div class="col-md-2">
        <select class="form-select form-select-sm field-type">
          ${Object.entries(FIELD_TYPES).map(([val, label]) =>
            `<option value="${val}" ${fieldDef.type === val ? 'selected' : ''}>${label}</option>`
          ).join('')}
        </select>
      </div>
      <div class="col-md-2">
        <div class="form-check mt-1">
          <input type="checkbox" class="form-check-input field-required" id="req-${index}" ${fieldDef.required ? 'checked' : ''} />
          <label class="form-check-label" for="req-${index}">Required</label>
        </div>
      </div>
      <div class="col-md-2 text-end">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="this.parentElement.parentElement.parentElement.remove()">Remove</button>
      </div>
    </div>
  `;
  fieldsList.appendChild(row);
}

/**
 * Add a visibility condition row
 */
function addConditionRow(index, condDef = {}) {
  const conditionsList = document.getElementById('conditions-list');
  const row = document.createElement('div');
  row.className = 'condition-row border-bottom pb-2 mb-2';
  row.innerHTML = `
    <div class="row g-2">
      <div class="col-md-3">
        <input type="text" class="form-control form-control-sm cond-column" placeholder="Student field" value="${condDef.column || ''}" />
      </div>
      <div class="col-md-3">
        <select class="form-select form-select-sm cond-operator">
          ${Object.entries(OPERATORS).map(([val, label]) =>
            `<option value="${val}" ${condDef.operator === val ? 'selected' : ''}>${label}</option>`
          ).join('')}
        </select>
      </div>
      <div class="col-md-4">
        <input type="text" class="form-control form-control-sm cond-value" placeholder="Value (comma-separated)" value="${condDef.value || ''}" />
      </div>
      <div class="col-md-2 text-end">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="this.parentElement.parentElement.parentElement.remove()">Remove</button>
      </div>
    </div>
  `;
  conditionsList.appendChild(row);
}

/**
 * Populate include fields from student data
 */
function populateIncludeFields() {
  const container = document.getElementById('include-fields-container');
  if (!container) return;

  const commonFields = [
    'student_id', 'student_name', 'class_name', 'section', 'roll',
    'fathers_name', 'mothers_name', 'fathers_phone', 'mothers_phone',
    'nfc_uid', 'balance', 'nick_name', 'blood', 'house', 'card_status'
  ];

  container.innerHTML = commonFields.map((f, i) => `
    <label class="form-check me-3 d-inline-block">
      <input type="checkbox" class="form-check-input" value="${f}" />
      <span class="form-check-label">${f.replace(/_/g, ' ')}</span>
    </label>
  `).join('');
}

/**
 * Save tab configuration
 */
async function saveTabConfig() {
  const tabName = document.getElementById('tab-name').value.trim();
  if (!tabName) {
    alert('Tab name is required');
    return;
  }

  // Collect fields
  const fields = Array.from(document.querySelectorAll('.field-row')).map(row => ({
    name: row.querySelector('.field-name').value.trim(),
    label: row.querySelector('.field-label').value.trim(),
    type: row.querySelector('.field-type').value,
    required: row.querySelector('.field-required').checked,
  })).filter(f => f.name);

  // Collect conditions
  const conditions = Array.from(document.querySelectorAll('.condition-row')).map(row => ({
    column: row.querySelector('.cond-column').value.trim(),
    operator: row.querySelector('.cond-operator').value,
    value: row.querySelector('.cond-value').value.trim(),
  })).filter(c => c.column);

  // Collect include fields
  const includeFields = Array.from(
    document.querySelectorAll('#include-fields-container input:checked')
  ).map(chk => chk.value);

  // Build tab config
  const tabConfig = {
    tab_name: tabName,
    fields_json: JSON.stringify(fields),
    condition_json: JSON.stringify({
      logic: document.getElementById('condition-logic').value,
      rules: conditions,
    }),
    include_fields_json: JSON.stringify(includeFields),
    icon_class: document.getElementById('tab-icon').value || 'bi-journal-bookmark-fill',
    sort_order: parseInt(document.getElementById('tab-sort').value) || 0,
    is_enabled: document.getElementById('tab-enabled').checked,
    default_editable: document.getElementById('tab-editable').checked,
  };

  // Save via API
  try {
    const response = await portalFetch('save_tab', tabConfig);
    if (response.result === 'success') {
      alert(response.message);
      bootstrap.Modal.getInstance(document.getElementById('tab-editor-modal')).hide();
      // Reload tab list
      loadAdminTabs();
    } else {
      alert('Error: ' + response.message);
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

/**
 * Delete a tab
 */
async function deleteTab(tabName) {
  if (!confirm(`Delete tab "${tabName}" and all submissions? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await portalFetch('delete_tab', { tab_name: tabName });
    if (response.result === 'success') {
      alert(response.message);
      loadAdminTabs();
    } else {
      alert('Error: ' + response.message);
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

/**
 * Load and display all tabs
 */
async function loadAdminTabList() {
  const container = document.getElementById('admin-tabs-list');
  if (!container) return;

  try {
    const tabs = await portalFetch('get_tabs', {});
    if (!Array.isArray(tabs)) return;

    container.innerHTML = tabs.length === 0
      ? '<p class="text-muted text-center py-4">No tabs created yet</p>'
      : tabs.map(tab => {
          const fieldCount = (() => {
            try {
              return JSON.parse(tab.fields_json || '[]').length;
            } catch {
              return 0;
            }
          })();

          return `
            <div class="col-md-6 mb-3">
              <div class="card h-100 shadow-sm">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-start mb-2">
                    <div>
                      <h6 class="card-title mb-0">${tab.tab_name}</h6>
                      <small class="text-muted">${fieldCount} fields</small>
                    </div>
                    <span class="badge ${tab.is_enabled ? 'bg-success' : 'bg-secondary'}">
                      ${tab.is_enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div class="d-flex gap-2 mt-3">
                    <button class="btn btn-sm btn-outline-primary" onclick="openTabEditor(${JSON.stringify(tab)})">
                      <i class="bi bi-pencil"></i> Edit
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteTab('${tab.tab_name}')">
                      <i class="bi bi-trash"></i> Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('');
  } catch (err) {
    console.error('Failed to load tabs:', err);
    container.innerHTML = '<p class="text-danger">Error loading tabs</p>';
  }
}

/**
 * Export tabs
 */
async function exportTabs() {
  try {
    const response = await portalFetch('export_tabs', { format: 'json' });
    if (response.result === 'success') {
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = response.filename || 'tabs.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
}

/**
 * Import tabs
 */
function importTabs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.csv';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const content = await file.text();
      let tabsJson;

      if (file.name.endsWith('.json')) {
        tabsJson = JSON.parse(content);
      } else if (file.name.endsWith('.csv')) {
        alert('CSV import not yet supported. Please use JSON format.');
        return;
      }

      const response = await portalFetch('import_tabs', { tabs_json: tabsJson });
      if (response.result === 'success') {
        alert(response.message + `\n\nCreated: ${response.details.created.length}\nUpdated: ${response.details.updated.length}\nSkipped: ${response.details.skipped.length}`);
        loadAdminTabList();
      } else {
        alert('Import failed: ' + response.message);
      }
    } catch (err) {
      alert('Import error: ' + err.message);
    }
  };
  input.click();
}

// Export for global use
window.AdminTabs = {
  openTabEditor,
  deleteTab,
  loadAdminTabList,
  exportTabs,
  importTabs,
};
