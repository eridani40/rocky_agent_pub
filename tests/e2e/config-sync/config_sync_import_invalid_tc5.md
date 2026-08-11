# ET case: EC-5 导入非配置文件（普通 JSON）

> case_id: config_sync_import_invalid_tc5
> source: test-plan EC-5

## Prerequisites
- dev app is running
- Prepare a plain JSON file (not a config export, e.g. `{"hello":"world"}`)

## Action targets

1. Open App Settings → Config Sync tab
2. Click Import
3. Select the plain JSON file
4. Verify: error message displayed (e.g. parse failure / invalid format)
5. Verify: NOT entering tree selection page (stays on file selection or returns to landing)
6. Screenshot the error state

## Verdict
- pass: Error shown, no tree page, clear user-readable message
- small: Error shown but message unclear
- blocking: No error / crash / enters tree page with broken state
