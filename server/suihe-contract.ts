// Frozen Suihe gateway contract and app image-preparation policy. Keep these
// separate from the native Ark contract and from price snapshots.
export const SUIHE_VIDEO_CONTRACT_VERSION = 'suihe-video-reply-2026-10-29'
export function suiheVideoContractSnapshot(model) {
  return { version: SUIHE_VIDEO_CONTRACT_VERSION, model: String(model?.publicId || model?.id || ''),
    extension: 'unverified', frameLibraryUrls: true, imageLibraryPreparation: 'all_image_slots', editReferenceDuration: 'precise_source_seconds',
    editEstimateDuration: 'ceil_source_seconds', editRequestDuration: 'rounded_source_seconds', editSourceSeconds: undefined as number | undefined }
}
export function usesSuiheReplyContract(request) {
  const contract = request?.parameters?.suiheContract || request?.suiheContract
  return contract?.version === SUIHE_VIDEO_CONTRACT_VERSION
}
