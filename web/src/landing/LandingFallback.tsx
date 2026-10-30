import { useLang } from '../i18n'
import { LandingHeader, LandingHero } from './LandingHero'
import CanvasFilm from './CanvasFilm'
import './landing.css'
export default function LandingFallback() {
  const { lang, setLang } = useLang()
  return <div className="miao-site" id="top"><LandingHeader lang={lang} setLang={setLang}/><main><LandingHero lang={lang} film={<CanvasFilm lang={lang}/>}/></main></div>
}
