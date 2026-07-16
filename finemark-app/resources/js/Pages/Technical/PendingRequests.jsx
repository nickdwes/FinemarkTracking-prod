import { Link } from '@inertiajs/react';
import { useEffect, useState } from 'react';
import DashboardLayout from '@/Layouts/DashboardLayout';

export default function PendingRequests() {
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [lastRefreshed, setLastRefreshed] = useState('Not yet');

    const menuItems = [
        { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
        { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
        { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
    ];

    const fetchRequests = async () => {
        setLoading(true);
        setError('');

        try {
            const response = await window.axios.get('/api/technical/pending-requests');
            if (response.data?.success) {
                setRequests(response.data.data.items ?? []);
            } else {
                setError(response.data?.error?.message || 'Failed to load requests.');
            }
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to load requests.');
        } finally {
            setLoading(false);
            setLastRefreshed(new Date().toLocaleString());
        }
    };

    const formatDate = (value) => {
        if (!value) return '';
        return new Date(value).toLocaleString();
    };

    useEffect(() => {
        fetchRequests();
    }, []);

    return (
        <DashboardLayout title="Pending Requests" roleLabel="Technical Officer" menuItems={menuItems}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-slate-600">
                    Review incoming installation requests and assign technicians.
                </p>
                <div className="flex items-center gap-3 text-sm">
                    <button className="text-slate-500" type="button" onClick={fetchRequests}>
                        Refresh
                    </button>
                    <Link className="font-medium text-indigo-600" href={route('technical.assign')}>
                        Assign Technician
                    </Link>
                </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Pending</div>
                    <div className="mt-2 text-2xl font-semibold text-slate-900">{requests.length}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Queue Health</div>
                    <div className="mt-2 text-sm text-slate-600">Stable</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase text-slate-500">Last Refresh</div>
                    <div className="mt-2 text-sm text-slate-600">{lastRefreshed}</div>
                </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                        <tr>
                            <th className="px-4 py-3 text-left font-semibold">Customer</th>
                            <th className="px-4 py-3 text-left font-semibold">Vehicle</th>
                            <th className="px-4 py-3 text-left font-semibold">Requested</th>
                            <th className="px-4 py-3 text-left font-semibold">Preferred</th>
                            <th className="px-4 py-3 text-left font-semibold">Location</th>
                            <th className="px-4 py-3 text-left font-semibold">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {loading && (
                            <tr>
                                <td className="px-4 py-4 text-slate-500" colSpan="6">
                                    Loading requests...
                                </td>
                            </tr>
                        )}
                        {!loading && error && (
                            <tr>
                                <td className="px-4 py-4 text-red-600" colSpan="6">
                                    {error}
                                </td>
                            </tr>
                        )}
                        {!loading && !error && requests.length === 0 && (
                            <tr>
                                <td className="px-4 py-4 text-slate-500" colSpan="6">
                                    No pending requests.
                                </td>
                            </tr>
                        )}
                        {!loading &&
                            !error &&
                            requests.map((request) => (
                                <tr key={request.id}>
                                    <td className="px-4 py-3 font-medium text-slate-800">
                                        {request.customer_name}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {request.registration_number}
                                        <br />
                                        <span className="text-xs text-slate-400">
                                            {request.make} {request.model}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {formatDate(request.requested_at)}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {formatDate(request.preferred_date) || 'N/A'}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {request.location || 'N/A'}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Link
                                            className="text-xs font-semibold text-indigo-600"
                                            href={route('technical.assign', { requestId: request.id })}
                                        >
                                            Assign
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </DashboardLayout>
    );
}
