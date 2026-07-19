# Fix share-link copying in the app

## Summary

Copying a share or invite link inside the app reports `Copy failed` instead of
placing the link on the system clipboard.

## Requirements

- Make share-link copy actions work in the packaged desktop app and supported
  browser contexts.
- Preserve a safe fallback when the asynchronous Clipboard API is unavailable
  or rejects the write.
- Keep user-visible success and failure feedback accurate.

## Acceptance Criteria

- A regression test reproduces the failing clipboard path before the fix.
- Share and invite links copy when `navigator.clipboard.writeText` rejects or is
  unavailable but a supported fallback exists.
- Existing clipboard success behavior and relevant frontend checks still pass.
