import React from 'react';
import { FileText, Users, Settings, Activity, Mail, Check } from 'lucide-react';

const STEPS = [
  { id: 1, label: 'Wanted List', icon: FileText },
  { id: 2, label: 'Target Publishers', icon: Users },
  { id: 3, label: 'API Config & Fetch', icon: Settings },
  { id: 4, label: 'Gap Analysis', icon: Activity },
  { id: 5, label: 'Outreach Messages', icon: Mail },
];

interface StepIndicatorProps {
  currentStep: number;
  onStepClick: (step: number) => void;
  hasUploaded: boolean;
  hasPublishers: boolean;
  hasFetched: boolean;
}

export default function StepIndicator({
  currentStep,
  onStepClick,
  hasUploaded,
  hasPublishers,
  hasFetched
}: StepIndicatorProps) {
  const isStepSelectable = (stepId: number) => {
    if (stepId === 1) return true;
    if (stepId === 2) return hasUploaded;
    if (stepId === 3) return hasUploaded && hasPublishers;
    if (stepId === 4) return hasUploaded && hasPublishers && hasFetched;
    if (stepId === 5) return hasUploaded && hasPublishers && hasFetched;
    return false;
  };

  return (
    <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="step-bar">
        {STEPS.map((step) => {
          const Icon = step.icon;
          const isActive = step.id === currentStep;
          const isCompleted = step.id < currentStep;
          const selectable = isStepSelectable(step.id);

          let tabClass = 'step-tab';
          if (isActive) tabClass += ' active';
          if (isCompleted) tabClass += ' completed';
          if (selectable) tabClass += ' selectable';

          return (
            <button
              key={step.id}
              className={tabClass}
              onClick={() => selectable && onStepClick(step.id)}
              disabled={!selectable}
            >
              {isCompleted ? (
                <Check size={14} strokeWidth={2.5} />
              ) : (
                <Icon size={14} strokeWidth={2} />
              )}
              <span>{step.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
