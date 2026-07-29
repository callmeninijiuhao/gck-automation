import {
  ShieldCheck,
  BarChart3,
  Target,
  Key,
  Boxes,
  Scale,
} from 'lucide-react';
import { NavItem } from './types';

export const NAV_STRUCTURE: NavItem[] = [
  {
    id: 'pub-dev',
    label: 'PUB DEV',
    children: [
      {
        id: 'onboarding-validator',
        label: 'Pub Onboarding Validator',
        path: '/',
        icon: ShieldCheck
      }
    ]
  },
  {
    id: 'cust-success',
    label: 'CUSTOMER SUCCESS',
    children: [
      {
        id: 'top-bundle-analysis',
        label: 'Bundle Level Analysis',
        path: '/top-bundle-analysis',
        icon: Boxes
      },
      {
        id: 'seller-domain-shooter',
        label: 'Seller Domain Shooter',
        path: '/seller-domain-shooter',
        icon: BarChart3
      },
      {
        id: 'ap-shooter',
        label: 'Auction Package Analyzer',
        path: '/ap-shooter',
        icon: Target
      },
      {
        id: 'discrepancy-checkin',
        label: 'Discrepancy Check-in',
        path: '/discrepancy-checkin',
        icon: Scale
      }
    ]
  },
  {
    id: 'api-token',
    label: 'API TOKEN',
    children: [
      {
        id: 'token-management',
        label: 'Token Management',
        path: '/token-management',
        icon: Key
      }
    ]
  }
];
