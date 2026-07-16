<?php

namespace App\Http\Requests\Api;

class TwoFactorRequest extends ApiRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'method' => ['sometimes', 'string', 'max:50'],
        ];
    }
}
