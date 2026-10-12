// Order matters: the API must be in place before the app's modules read `window.hermit`.
import './polyfills'
import './install'
import '../renderer/src/main'
import './mobile.css'
