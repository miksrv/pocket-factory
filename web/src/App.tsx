import { Navigate, Route, Routes } from 'react-router-dom'

import { Layout } from './components/Layout'
import { AgentsPage } from './pages/Agents'
import { ChatPage } from './pages/Chat'
import { HistoryPage } from './pages/History'
import { OverviewPage } from './pages/Overview'
import { PresetsPage } from './pages/Presets'
import { ProjectsPage } from './pages/Projects'
import { SessionPage, SessionsPage } from './pages/Sessions'
import { SettingsPage } from './pages/Settings'
import { SkillsPage } from './pages/Skills'
import { TaskPage, TasksPage } from './pages/Tasks'

export function App() {
    return (
        <Routes>
            <Route element={<Layout />}>
                <Route index element={<OverviewPage />} />
                <Route path="tasks" element={<TasksPage />} />
                <Route path="tasks/:id" element={<TaskPage />} />
                <Route path="chat" element={<ChatPage />} />
                <Route path="chat/:id" element={<ChatPage />} />
                <Route path="sessions" element={<SessionsPage />} />
                <Route path="sessions/:id" element={<SessionPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:name" element={<AgentsPage />} />
                <Route path="skills" element={<SkillsPage />} />
                <Route path="skills/:name" element={<SkillsPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="projects/:name" element={<ProjectsPage />} />
                <Route path="presets" element={<PresetsPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    )
}
