import { Navigate, Route, Routes } from 'react-router-dom'

import { Layout } from './components/Layout'
import { ChatPage } from './pages/Chat'
import { OverviewPage } from './pages/Overview'
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
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    )
}
