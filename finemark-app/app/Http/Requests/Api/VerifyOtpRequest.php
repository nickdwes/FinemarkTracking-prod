<?php

namespace App\Http\Requests\Api;

class VerifyOtpRequest extends ApiRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'purpose' => ['required', 'string', 'max:100'],
            'code' => ['required', 'string', 'max:12'],
            'sent_to' => ['required', 'string', 'max:255'],
        ];
    }
}
