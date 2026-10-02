import { Fragment } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { AuthProvider } from './components/Auth'
import { Layout } from './components/Layout'
import { ConfirmProvider } from './components/Modal'
import { AgentsPage } from './pages/Agents'
import { AuditPage } from './pages/Audit'
import { ChatPage } from './pages/Chat'
import { OverviewPage } from './pages/Overview'
import { PresetsPage } from './pages/Presets'
import { ProjectsPage } from './pages/Projects'
import { SchedulesPage } from './pages/Schedules'
import { SessionPage, SessionsPage } from './pages/Sessions'
import { SettingsPage } from './pages/Settings'
import { SkillsPage } from './pages/Skills'
import { TaskPage, TasksPage } from './pages/Tasks'

/** Remounts the page when the route id changes, so per-id state (a transcript window) never mixes two ids. */
function Keyed({ element }: { element: React.ReactElement }) {
    const { id } = useParams()
    return <Fragment key={id}>{element}</Fragment>
}

export function App() {
    return (
        <ConfirmProvider>
            <AuthProvider>
                <Routes>
                    <Route element={<Layout />}>
                        <Route index element={<OverviewPage />} />
                        <Route path="tasks" element={<TasksPage />} />
                        <Route path="tasks/:id" element={<TaskPage />} />
                        <Route path="chat" element={<ChatPage />} />
                        <Route path="chat/:id" element={<ChatPage />} />
                        <Route path="sessions" element={<SessionsPage />} />
                        <Route path="sessions/:id" element={<Keyed element={<SessionPage />} />} />
                        <Route path="audit" element={<AuditPage />} />
                        <Route path="agents" element={<AgentsPage />} />
                        <Route path="agents/:name" element={<AgentsPage />} />
                        <Route path="skills" element={<SkillsPage />} />
                        <Route path="skills/:name" element={<SkillsPage />} />
                        <Route path="projects" element={<ProjectsPage />} />
                        <Route path="projects/:name" element={<ProjectsPage />} />
                        <Route path="schedules" element={<SchedulesPage />} />
                        <Route path="schedules/:name" element={<SchedulesPage />} />
                        <Route path="presets" element={<PresetsPage />} />
                        <Route path="settings" element={<SettingsPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                        </Route>
                </Routes>
            </AuthProvider>
        </ConfirmProvider>
    )
}
