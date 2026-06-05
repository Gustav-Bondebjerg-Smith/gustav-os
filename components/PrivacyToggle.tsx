'use client'

// Privatlivs-toggle: slører nettoformue + syndeudgifter ved at sætte klassen
// `fin-private` på <html>. Staten gemmes i localStorage, så den DELES mellem
// forsiden og /finans og overlever reload. Et no-flash-script i layout.tsx sætter
// klassen FØR paint, så tallene aldrig blinker frem når sløringen er slået til.
//
// "Synergistisk": de to toggles (forside + finans) er aldrig på skærmen samtidig
// (forskellige ruter), men deler state -> trykker man den ene, følger den anden
// med ved navigation. På tværs af ÅBNE faner synkroniserer 'storage'-eventet live;
// samme fane bruger window-eventet (fremtidssikrer hvis to toggles en dag står på
// samme side). Staten ER en ekstern store (DOM-klasse + localStorage), så vi læser
// den med useSyncExternalStore i stedet for at spejle den i React-state.
import { useSyncExternalStore } from 'react'
import { Eye, EyeOff } from 'lucide-react'

const KEY = 'fin-private'
const EVENT = 'fin-private-change'

function isOn(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains(KEY)
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange)
  // Anden fane skiftede -> spejl klassen i denne fane, så sløringen følger med.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    document.documentElement.classList.toggle(KEY, e.newValue === '1')
    onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function PrivacyToggle() {
  // SSR/hydration: serveren kender ikke localStorage -> antag "vist" (false). Selve
  // tallene er allerede korrekt slørede fra første paint via no-flash-scriptet; kun
  // ikonet kan nå at skifte fra Eye -> EyeOff lige efter hydrering.
  const hidden = useSyncExternalStore(subscribe, isOn, () => false)

  function toggle() {
    const next = !isOn()
    document.documentElement.classList.toggle(KEY, next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      /* privat-tilstand / blokeret storage: sløringen virker stadig for denne side */
    }
    window.dispatchEvent(new Event(EVENT))
  }

  return (
    <button
      type="button"
      className="priv-toggle"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={hidden ? 'Vis beløb' : 'Skjul beløb'}
      title={hidden ? 'Vis beløb' : 'Skjul beløb'}
    >
      {hidden ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
    </button>
  )
}
