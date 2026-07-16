import { useEffect, useState } from 'react';
import DashboardLayout from '@/Layouts/DashboardLayout';

export default function AssignmentForm() {
    const [pendingRequests, setPendingRequests] = useState([]);
    const [technicians, setTechnicians] = useState([]);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [form, setForm] = useState({
        requestId: '',
        technicianId: '',
        scheduledAt: '',
        notes: '',
    });

    const menuItems = [
        { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
        { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
        { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
    ];

    const loadData = async () => {
        setError('');
        setMessage('');

        try {
            const [requestsResponse, techResponse] = await Promise.all([
                window.axios.get('/api/technical/pending-requests'),
                window.axios.get('/api/technical/technicians'),
            ]);

            setPendingRequests(requestsResponse.data?.data?.items ?? []);
            setTechnicians(techResponse.data?.data?.items ?? []);
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to load assignment data.');
        }
    };

    const submitAssignment = async (event) => {
        event.preventDefault();

        if (!form.requestId || !form.technicianId) {
            setError('Please select a request and technician.');
            return;
        }

        setSubmitting(true);
        setError('');
        setMessage('');

        try {
            const response = await window.axios.post(`/api/technical/assign/${form.requestId}`, {
                technician_id: form.technicianId,
                scheduled_at: form.scheduledAt || null,
                notes: form.notes || null,
            });

            if (response.data?.success) {
                setMessage('Assignment created successfully.');
                setForm({ requestId: '', technicianId: '', scheduledAt: '', notes: '' });
                await loadData();
            } else {
                setError(response.data?.error?.message || 'Failed to assign technician.');
            }
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to assign technician.');
        } finally {
            setSubmitting(false);
        }
    };

    useEffect(() => {
        loadData();
        const requestId = new URLSearchParams(window.location.search).get('requestId');
        if (requestId) {
            setForm((prev) => ({ ...prev, requestId }));
        }
    }, []);

    return (
        <DashboardLayout title="Assignment Form" roleLabel="Technical Officer" menuItems={menuItems}>
            <p className="text-sm text-slate-600">Select a request and technician, then submit to create an assignment.</p>

            <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
                <form className="space-y-4" onSubmit={submitAssignment}>
                    <div>
                        <label className="text-sm font-medium text-slate-700">Pending Request</label>
                        <select
                            value={form.requestId}
                            onChange={(event) => setForm({ ...form, requestId: event.target.value })}
                            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                        >
                            <option value="" disabled>
                                Select a request
                            </option>
                            {pendingRequests.map((request) => (
                                <option key={request.id} value={request.id}>
                                    {request.customer_name} - {request.registration_number}
                                </option>
                            ))}
                        </select>
                        {pendingRequests.length === 0 && (
                            <p className="mt-1 text-xs text-slate-400">No pending requests found.</p>
                        )}
                    </div>

                    <div>
                        <label className="text-sm font-medium text-slate-700">Technician</label>
                        <select
                            value={form.technicianId}
                            onChange={(event) => setForm({ ...form, technicianId: event.target.value })}
                            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                        >
                            <option value="" disabled>
                                Select a technician
                            </option>
                            {technicians.map((tech) => (
                                <option key={tech.id} value={tech.id}>
                                    {tech.name} ({tech.email})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="text-sm font-medium text-slate-700">Scheduled At</label>
                        <input
                            type="datetime-local"
                            value={form.scheduledAt}
                            onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })}
                            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                        />
                    </div>

                    <div>
                        <label className="text-sm font-medium text-slate-700">Notes</label>
                        <textarea
                            rows="3"
                            value={form.notes}
                            onChange={(event) => setForm({ ...form, notes: event.target.value })}
                            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                            placeholder="Optional notes"
                        />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="submit"
                            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                            disabled={submitting}
                        >
                            {submitting ? 'Assigning...' : 'Assign Technician'}
                        </button>
                        <button type="button" className="text-sm text-slate-500" onClick={loadData}>
                            Refresh lists
                        </button>
                    </div>

                    {message && <div className="text-sm text-green-600">{message}</div>}
                    {error && <div className="text-sm text-red-600">{error}</div>}
                </form>
            </div>
        </DashboardLayout>
    );
}
