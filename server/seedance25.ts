// Verified 2026-10-13: Ark create-video-generation-task-api and model-pricing.
// Keep this model separate from the 2.0 provider contracts and historical prices.
export const SEEDANCE25_ID = 'doubao-seedance-2-5-260628'
export function isSeedance25(model) {
  const id = typeof model === 'string' ? model : model?.publicId || model?.id
  return ['seedance-2.5', 'seedance-2-5', 'doubao-seedance-2-5', SEEDANCE25_ID].includes(id)
}
export const SEEDANCE25_PRICING = Object.freeze({
  rates: {
    '480p': { noVideoRmbPerMillion:70, withVideoRmbPerMillion:42 },
    '720p': { noVideoRmbPerMillion:70, withVideoRmbPerMillion:42 },
    '1080p': { noVideoRmbPerMillion:77, withVideoRmbPerMillion:46 },
  },
  pixels: {
    '480p': {'16:9':854*480,'9:16':854*480,'4:3':752*560,'3:4':752*560,'1:1':640*640,'21:9':992*432},
    '720p': {'16:9':1280*720,'9:16':1280*720,'4:3':1112*834,'3:4':1112*834,'1:1':960*960,'21:9':1470*630},
    '1080p': {'16:9':1920*1080,'9:16':1920*1080,'4:3':1664*1248,'3:4':1664*1248,'1:1':1440*1440,'21:9':2206*946},
  },
  // Official minimum-token table formula: output + max(ceil(output*2/3), input).
  // https://bytedance.larkoffice.com/wiki/FXaYwxzJ5i5Zdik32ipcWzt7nxd
  minimumInputFraction: 2/3,
  fps: 24,
})
