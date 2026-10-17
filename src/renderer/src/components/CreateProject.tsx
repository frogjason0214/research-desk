import { useState } from 'react'

/** 還沒有任何專案時的引導畫面 */
export function CreateProject({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <form
      className="create-project"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name)
      }}
    >
      <h2>建立你的第一個研究專案</h2>
      <p>通常就是你的碩士論文。建立後會自動帶入心理學碩士的里程碑範本，之後都能修改。</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="例如：正念訓練與考試焦慮"
        aria-label="專案名稱"
        autoFocus
      />
      <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
        建立專案
      </button>
    </form>
  )
}
