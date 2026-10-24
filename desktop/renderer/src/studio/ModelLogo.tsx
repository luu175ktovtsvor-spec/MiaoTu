import { modelLogoSvg } from './canvas/assets/model-logos'

// 外壳页面里的模型标识，和画布的 modelIcon 用同一份官方标识；认不出时显示模型名首字母。
export default function ModelLogo({ model, size = 18 }: { model: string; size?: number }) {
  const svg = modelLogoSvg(model)
  return svg
    ? <span className="model-logo" style={{ width: size, height: size }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    : <span className="model-logo is-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }} aria-hidden="true">{Array.from(String(model || 'A'))[0].toUpperCase()}</span>
}
