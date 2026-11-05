#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
k6_bin="${K6_BIN:-k6}"
read -r -a user_stages <<< "${CRM_USER_STAGES:-100 1000 5000 10000 25000 50000 100000}"

if ! command -v "$k6_bin" >/dev/null 2>&1; then
  printf 'k6 was not found. Install k6 before running the staged test.\n' >&2
  exit 127
fi

if [[ "${#user_stages[@]}" -eq 0 ]]; then
  printf 'CRM_USER_STAGES must include at least one target.\n' >&2
  exit 2
fi

for target_users in "${user_stages[@]}"; do
  printf 'Starting CRM auth load stage with %s VUs.\n' "$target_users"
  CRM_TARGET_USERS="$target_users" "$k6_bin" run "$script_dir/crm-auth.js"
done
