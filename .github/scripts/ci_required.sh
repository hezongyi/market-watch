#!/usr/bin/env bash
set -euo pipefail

if [[ "${CLASSIFICATION_RESULT:-}" != success ]]; then
  echo "Change classification did not succeed; required check cannot pass."
  exit 1
fi

case "${DOCS_ONLY:-}" in
  true) expected=skipped ;;
  false) expected=success ;;
  *) echo "Missing or invalid change classification."; exit 1 ;;
esac

if [[ "${CHECK_RESULT:-}" != "$expected" ]]; then
  echo "Expected $expected, received ${CHECK_RESULT:-missing}."
  exit 1
fi

if [[ "$expected" == skipped ]]; then
  echo "Documentation only: heavy checks intentionally skipped."
else
  echo "Required checks succeeded."
fi
