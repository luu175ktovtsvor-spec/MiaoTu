#!/usr/bin/env bash
set -u
set -o pipefail

node scripts/verify/admin_truth_acceptance.ts
ui_status=0
node scripts/verify/admin_ui_acceptance.ts || ui_status=$?
node scripts/verify/write_admin_report.ts
exit "$ui_status"
