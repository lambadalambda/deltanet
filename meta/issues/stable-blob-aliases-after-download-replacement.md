# Keep blob URLs stable when downloads replace messages

## Summary

Preserve a pending attachment's blob URL when Delta Chat completes a full-message
download by replacing the pre-message with one or more messages that have new IDs.

## Requirements

- Detect the replacement messages emitted after `downloadFullMessage` without
  guessing from unrelated messages in the same chat.
- Resolve the original `/headwater/blob/:msgId` URL to the downloaded attachment
  bytes, or update clients to the replacement status and URL automatically.
- Preserve authentication and capability checks on every stable or redirected
  blob request.
- Support the one-to-many replacement allowed by Delta Chat core.

## Acceptance Criteria

- A pre-message removed by core after download does not leave its attachment
  placeholder polling a permanent 404.
- Replacement handling cannot expose an unrelated attachment from the same chat.
- Daemon integration and frontend browser tests cover old-ID removal and new-ID
  attachment availability without a page reload.

## Notes

- Delta Chat documents that `downloadFullMessage` may replace a message with one
  or more messages using different IDs and emits `MsgsChanged` afterward.
- This needs a stable identity or explicit replacement mapping; timestamp or
  filename matching is not sufficiently trustworthy.
