import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './views/Sidebar'
import { FullWindow } from './views/FullWindow'
import './styles.css'

// 同一份程式，依網址的 #/sidebar 或 #/full 決定顯示哪個畫面
const view = window.location.hash.replace('#/', '')
document.body.dataset.view = view === 'sidebar' ? 'sidebar' : 'full'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{view === 'sidebar' ? <Sidebar /> : <FullWindow />}</StrictMode>
)
