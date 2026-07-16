<template>
    <DashboardLayout title="Assignments" role-label="Technical Officer" :menu-items="menuItems">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p class="text-sm text-slate-600">Track technician progress across all assignments.</p>
            <button class="text-sm text-slate-500" type="button" @click="fetchAssignments">Refresh</button>
        </div>

        <div class="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table class="min-w-full divide-y divide-slate-200 text-sm">
                <thead class="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                        <th class="px-4 py-3 text-left font-semibold">Customer</th>
                        <th class="px-4 py-3 text-left font-semibold">Technician</th>
                        <th class="px-4 py-3 text-left font-semibold">Scheduled</th>
                        <th class="px-4 py-3 text-left font-semibold">Status</th>
                        <th class="px-4 py-3 text-left font-semibold">Action</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                    <tr v-if="loading">
                        <td class="px-4 py-4 text-slate-500" colspan="5">Loading assignments...</td>
                    </tr>
                    <tr v-else-if="error">
                        <td class="px-4 py-4 text-red-600" colspan="5">{{ error }}</td>
                    </tr>
                    <tr v-else-if="assignments.length === 0">
                        <td class="px-4 py-4 text-slate-500" colspan="5">No assignments found.</td>
                    </tr>
                    <tr v-else v-for="assignment in assignments" :key="assignment.id">
                        <td class="px-4 py-3 font-medium text-slate-800">
                            {{ assignment.customer_name }}<br />
                            <span class="text-xs text-slate-400">{{ assignment.registration_number }}</span>
                        </td>
                        <td class="px-4 py-3 text-slate-600">{{ assignment.technician_name }}</td>
                        <td class="px-4 py-3 text-slate-600">
                            {{ formatDate(assignment.scheduled_at) || 'N/A' }}
                        </td>
                        <td class="px-4 py-3">
                            <span class="rounded-full px-2 py-1 text-xs font-semibold" :class="statusClass(assignment.status)">
                                {{ assignment.status }}
                            </span>
                        </td>
                        <td class="px-4 py-3">
                            <button
                                v-if="nextStatus(assignment.status)"
                                class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"
                                type="button"
                                @click="updateStatus(assignment, nextStatus(assignment.status))"
                            >
                                Move to {{ nextStatus(assignment.status) }}
                            </button>
                            <span v-else class="text-xs text-slate-400">Completed</span>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </DashboardLayout>
</template>

<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';
import { onMounted, ref } from 'vue';

const menuItems = [
    { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
    { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
    { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
];

const assignments = ref([]);
const loading = ref(false);
const error = ref('');

const flow = {
    pending: 'assigned',
    assigned: 'in_progress',
    in_progress: 'completed',
    completed: 'certified',
    certified: null,
};

const fetchAssignments = async () => {
    loading.value = true;
    error.value = '';

    try {
        const response = await window.axios.get('/api/technical/assignments');
        if (response.data?.success) {
            assignments.value = response.data.data.items ?? [];
        } else {
            error.value = response.data?.error?.message || 'Failed to load assignments.';
        }
    } catch (err) {
        error.value = err?.response?.data?.error?.message || 'Failed to load assignments.';
    } finally {
        loading.value = false;
    }
};

const updateStatus = async (assignment, status) => {
    if (!status) return;
    try {
        const response = await window.axios.put(`/api/technical/update-status/${assignment.id}`, {
            status,
        });

        if (response.data?.success) {
            assignment.status = status;
        } else {
            error.value = response.data?.error?.message || 'Failed to update status.';
        }
    } catch (err) {
        error.value = err?.response?.data?.error?.message || 'Failed to update status.';
    }
};

const nextStatus = (status) => flow[status] || null;

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

const formatDate = (value) => {
    if (!value) return '';
    return new Date(value).toLocaleString();
};

onMounted(fetchAssignments);
</script>
