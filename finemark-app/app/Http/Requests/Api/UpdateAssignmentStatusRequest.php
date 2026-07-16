<?php

namespace App\Http\Requests\Api;

class UpdateAssignmentStatusRequest extends ApiRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'status' => ['required', 'string', 'in:pending,assigned,in_progress,completed,certified'],
        ];
    }
}
