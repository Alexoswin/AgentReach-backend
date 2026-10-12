import { ProspectProfile } from '../icp';

export type CompanyCandidate = { name: string; domain: string };

export interface ProspectSource {
  findCompanies(input: {
    profile: ProspectProfile;
    limit: number;
    exclude: Set<string>;
  }): Promise<CompanyCandidate[]>;
}
