<template>
    <DashboardLayout title="Pending Requests" role-label="Technical Officer" :menu-items="menuItems">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p class="text-sm text-slate-600">
                Review incoming installation requests and assign technicians.
            </p>
            <div class="flex items-center gap-3 text-sm">
                <button class="text-slate-500" type="button" @click="fetchRequests">Refresh</button>
                <Link class="font-medium text-indigo-600" :href="route('technical.assign')">
                    Assign Technician
                </Link>
            </div>
        </div>

        <div class="mt-6 grid gap-4 sm:grid-cols-3">
            <div class="rounded-xl border border-slate-200 bg-white p-4">
                <div class="text-xs uppercase text-slate-500">Pending</div>
                <div class="mt-2 text-2xl font-semibold text-slate-900">{{ requests.length }}</div>
            </div>
            <div class="rounded-xl border border-slate-200 bg-white p-4">
                <div class="text-xs uppercase text-slate-500">Queue Health</div>
                <div class="mt-2 text-sm text-slate-600">Stable</div>
            </div>
            <div class="rounded-xl border border-slate-200 bg-white p-4">
                <div class="text-xs uppercase text-slate-500">Last Refresh</div>
                <div class="mt-2 text-sm text-slate-600">{{ lastRefreshed }}</div>
            </div>
        </div>

        <div class="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table class="min-w-full divide-y divide-slate-200 text-sm">
                <thead class="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                        <th class="px-4 py-3 text-left font-semibold">Customer</th>
                        <th class="px-4 py-3 text-left font-semibold">Vehicle</th>
                        <th class="px-4 py-3 text-left font-semibold">Requested</th>
                        <th class="px-4 py-3 text-left font-semibold">Preferred</th>
                        <th class="px-4 py-3 text-left font-semibold">Location</th>
                        <th class="px-4 py-3 text-left font-semibold">Action</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                    <tr v-if="loading">
                        <td class="px-4 py-4 text-slate-500" colspan="6">Loading requests...</td>
                    </tr>
                    <tr v-else-if="error">
                        <td class="px-4 py-4 text-red-600" colspan="6">{{ error }}</td>
                    </tr>
                    <tr v-else-if="requests.length === 0">
                        <td class="px-4 py-4 text-slate-500" colspan="6">No pending requests.</td>
                    </tr>
                    <tr v-else v-for="request in requests" :key="request.id">
                        <td class="px-4 py-3 font-medium text-slate-800">{{ request.customer_name }}</td>
                        <td class="px-4 py-3 text-slate-600">
                            {{ request.registration_number }}<br />
                            <span class="text-xs text-slate-400">{{ request.make }} {{ request.model }}</span>
                        </td>
                        <td class="px-4 py-3 text-slate-600">{{ formatDate(request.requested_at) }}</td>
                        <td class="px-4 py-3 text-slate-600">{{ formatDate(request.preferred_date) || 'N/A' }}</td>
                        <td class="px-4 py-3 text-slate-600">{{ request.location || 'N/A' }}</td>
                        <td class="px-4 py-3">
                            <Link
                                class="text-xs font-semibold text-indigo-600"
                                :href="route('technical.assign', { requestId: request.id })"
                            >
                                Assign
                            </Link>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </DashboardLayout>
</template>

<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';
import { Link } from '@inertiajs/vue3';
import { onMounted, ref } from 'vue';

const menuItems = [
    { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
    { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
    { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
];

const requests = ref([]);
const loading = ref(false);
const error = ref('');
const lastRefreshed = ref('Not yet');

const fetchRequests = async () => {
    loading.value = true;
    error.value = '';

    try {
        const response = await window.axios.get('/api/technical/pending-requests');
        if (response.data?.success) {
            requests.value = response.data.data.items ?? [];
        } else {
            error.value = response.data?.error?.message || 'Failed to load requests.';
        }
    } catch (err) {
        error.value = err?.response?.data?.error?.message || 'Failed to load requests.';
    } finally {
        loading.value = false;
        lastRefreshed.value = new Date().toLocaleString();
    }
};

const formatDate = (value) => {
    if (!value) return '';
    return new Date(value).toLocaleString();
};

onMounted(fetchRequests);
</script>
