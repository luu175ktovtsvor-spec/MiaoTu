import { useLang } from '../i18n'
import ChangelogFrame from './ChangelogFrame'
export default function ChangelogFallback() {
  const { lang, setLang } = useLang()
  return <ChangelogFrame lang={lang} setLang={setLang}/>
}
