import { useEffect, useState } from 'react';
import DashboardLayout from '@/Layouts/DashboardLayout';

export default function Assignments() {
    const [assignments, setAssignments] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const menuItems = [
        { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
        { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
        { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
    ];

    const flow = {
        pending: 'assigned',
        assigned: 'in_progress',
        in_progress: 'completed',
        completed: 'certified',
        certified: null,
    };

    const fetchAssignments = async () => {
        setLoading(true);
        setError('');

        try {
            const response = await window.axios.get('/api/technical/assignments');
            if (response.data?.success) {
                setAssignments(response.data.data.items ?? []);
            } else {
                setError(response.data?.error?.message || 'Failed to load assignments.');
            }
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to load assignments.');
        } finally {
            setLoading(false);
        }
    };

    const updateStatus = async (assignment, status) => {
        if (!status) return;

        try {
            const response = await window.axios.put(`/api/technical/update-status/${assignment.id}`, {
                status,
            });

            if (response.data?.success) {
                setAssignments((current) =>
                    current.map((item) => (item.id === assignment.id ? { ...item, status } : item))
                );
            } else {
                setError(response.data?.error?.message || 'Failed to update status.');
            }
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to update status.');
        }
    };

    const nextStatus = (status) => flow[status] || null;

    const formatDate = (value) => {
        if (!value) return '';
        return new Date(value).toLocaleString();
    };

    const statusClass = (status) => {
        switch (status) {
            case 'assigned':
                return 'bg-blue-50 text-blue-700';
            case 'in_progress':
                return 'bg-amber-50 text-amber-700';
            case 'completed':
                return 'bg-emerald-50 text-emerald-700';
            case 'certified':
                return 'bg-purple-50 text-purple-700';
            default:
                return 'bg-slate-100 text-slate-600';
        }
    };

    useEffect(() => {
        fetchAssignments();
    }, []);

    return (
        <DashboardLayout title="Assignments" roleLabel="Technical Officer" menuItems={menuItems}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-slate-600">Track technician progress across all assignments.</p>
                <button className="text-sm text-slate-500" type="button" onClick={fetchAssignments}>
                    Refresh
                </button>
            </div>

            <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                        <tr>
                            <th className="px-4 py-3 text-left font-semibold">Customer</th>
                            <th className="px-4 py-3 text-left font-semibold">Technician</th>
                            <th className="px-4 py-3 text-left font-semibold">Scheduled</th>
                            <th className="px-4 py-3 text-left font-semibold">Status</th>
                            <th className="px-4 py-3 text-left font-semibold">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {loading && (
                            <tr>
                                <td className="px-4 py-4 text-slate-500" colSpan="5">
                                    Loading assignments...
                                </td>
                            </tr>
                        )}
                        {!loading && error && (
                            <tr>
                                <td className="px-4 py-4 text-red-600" colSpan="5">
                                    {error}
                                </td>
                            </tr>
                        )}
                        {!loading && !error && assignments.length === 0 && (
                            <tr>
                                <td className="px-4 py-4 text-slate-500" colSpan="5">
                                    No assignments found.
                                </td>
                            </tr>
                        )}
                        {!loading &&
                            !error &&
                            assignments.map((assignment) => (
                                <tr key={assignment.id}>
                                    <td className="px-4 py-3 font-medium text-slate-800">
                                        {assignment.customer_name}
                                        <br />
                                        <span className="text-xs text-slate-400">
                                            {assignment.registration_number}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {assignment.technician_name}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {formatDate(assignment.scheduled_at) || 'N/A'}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span
                                            className={`rounded-full px-2 py-1 text-xs font-semibold ${statusClass(
                                                assignment.status
                                            )}`}
                                        >
                                            {assignment.status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        {nextStatus(assignment.status) ? (
                                            <button
                                                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"
                                                type="button"
                                                onClick={() =>
                                                    updateStatus(assignment, nextStatus(assignment.status))
                                                }
                                            >
                                                Move to {nextStatus(assignment.status)}
                                            </button>
                                        ) : (
                                            <span className="text-xs text-slate-400">Completed</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </DashboardLayout>
    );
}
